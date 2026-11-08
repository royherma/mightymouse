// The wire format between MightyMouse (writer) and the HAL plugin (reader).
//
// Both sides map this same struct over one shared file, so any change here is
// a BREAKING change that requires reinstalling the plugin -- bump MM_RING_ABI
// so a stale peer refuses to read rather than misinterprets.
//
// Lock-free by construction, not by atomics-on-both-sides: exactly one writer
// and one reader, each owning one cursor. The reader's realtime thread may
// never block, so there is no mutex anywhere in this file.

#ifndef MM_AUDIO_RING_H
#define MM_AUDIO_RING_H

#include <stdint.h>

// A FILE, not shm_open: POSIX shared memory is namespaced per-user on macOS, so
// the writer (the logged-in user) and coreaudiod (_coreaudiod) each got their
// own private object under one name and never saw each other's frames. The
// filesystem is the one namespace both can reach. Directory is created 0777 and
// the file 0666 by the installer, since either side may create it first.
#define MM_RING_DIR "/Library/Application Support/MightyMouse"
#define MM_RING_PATH MM_RING_DIR "/audio-ring"
#define MM_RING_ABI 1

// 48kHz mono float32. Must match CONFIG.PHONE_REMOTE.SYSTEM_AUDIO_SAMPLE_RATE
// and PHONE_MIC_CHANNELS -- the plugin advertises this rate to Core Audio, so a
// mismatch is silent pitch-shifting, not an error.
#define MM_RING_SAMPLE_RATE 48000
#define MM_RING_CHANNELS 1

// 32768 frames ~= 682ms. Power of two so the wrap is a mask, not a modulo, and
// large enough to absorb a scheduler hiccup on the writer without the reader
// running dry mid-callback.
#define MM_RING_CAPACITY_FRAMES 32768
#define MM_RING_MASK (MM_RING_CAPACITY_FRAMES - 1)

typedef struct {
  uint32_t abi;
  // Frame counts, free-running -- they are never wrapped, only masked at use.
  // 64-bit so wraparound is ~12 million years at 48kHz and needs no handling.
  volatile uint64_t write_index;
  volatile uint64_t read_index;
  // Set by the writer while audio is live. The reader emits silence when this
  // is 0, which is what makes an idle device behave like a muted mic instead
  // of a stalled one.
  volatile uint32_t active;
  // Bumped by the writer each time it starts a new session. The reader uses a
  // change here to resync rather than draining stale frames from a dead one.
  volatile uint32_t generation;
  float frames[MM_RING_CAPACITY_FRAMES * MM_RING_CHANNELS];
} MmAudioRing;

#endif
