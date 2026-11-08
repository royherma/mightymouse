// mm-ring-writer — reads float32 PCM on stdin, publishes it to the shared ring
// the HAL plugin reads.
//
// A separate process rather than a Node addon for the reason the other helpers
// in native/ are separate processes: no node-gyp, no ABI to keep in step with
// Electron (this repo already fights better-sqlite3's ABI swap every test run),
// and a crash here cannot take the app down.
//
// Marks the ring inactive on exit, so a dead writer leaves the plugin emitting
// silence rather than looping the last 682ms forever. The backing file itself
// outlives us on purpose: deleting it would strand the plugin's existing
// mapping on an unlinked inode, reading frames nobody will ever write again.
//
// Protocol: raw little-endian float32 mono @48kHz on stdin. No framing -- the
// stream IS the framing, and any partial read is just fewer samples this round.

#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <unistd.h>

#include "mm_audio_ring.h"

static MmAudioRing *gRing = NULL;

static void MM_Cleanup(void) {
  if (gRing != NULL) {
    // Plugin reads this every callback; clearing it is what turns the device
    // back into silence the instant the phone stops.
    gRing->active = 0;
    munmap(gRing, sizeof(MmAudioRing));
    gRing = NULL;
  }
}

static void MM_OnSignal(int sig) {
  (void)sig;
  MM_Cleanup();
  _exit(0);
}

int main(void) {
  // Without these the shm object survives a kill and the next run inherits a
  // ring whose indices point into someone else's session.
  signal(SIGINT, MM_OnSignal);
  signal(SIGTERM, MM_OnSignal);
  signal(SIGHUP, MM_OnSignal);
  signal(SIGPIPE, SIG_IGN);

  // Best-effort: succeeds only if the install already made the directory
  // world-writable, which is the supported path. /Library/Application Support
  // is root:admin, so an unprivileged writer cannot create it here.
  mkdir(MM_RING_DIR, 0777);

  int fd = open(MM_RING_PATH, O_CREAT | O_RDWR, 0666);
  if (fd < 0) {
    fprintf(stderr, "mm-ring-writer: cannot open %s (%s) -- is the driver installed?\n",
            MM_RING_PATH, strerror(errno));
    return 1;
  }
  // Explicit chmod rather than trusting open()'s mode: the umask (022 by
  // default) strips group+other write, so a file we created would be read-only
  // to coreaudiod, which needs to advance its own cursor in the header.
  fchmod(fd, 0666);
  if (ftruncate(fd, sizeof(MmAudioRing)) != 0) {
    fprintf(stderr, "mm-ring-writer: ftruncate failed\n");
    close(fd);
    return 1;
  }
  void *map = mmap(NULL, sizeof(MmAudioRing), PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
  close(fd);
  if (map == MAP_FAILED) {
    fprintf(stderr, "mm-ring-writer: mmap failed\n");
    return 1;
  }
  gRing = (MmAudioRing *)map;

  // Bump generation BEFORE going active: a plugin still holding a read cursor
  // from a previous writer must resync rather than drain stale frames.
  uint32_t generation = gRing->generation + 1;
  gRing->abi = MM_RING_ABI;
  gRing->write_index = 0;
  gRing->read_index = 0;
  gRing->generation = generation;
  gRing->active = 1;
  fprintf(stderr, "mm-ring-writer: ready (gen %u)\n", generation);
  fflush(stderr);

  // Sized well under the ring so a single read can never lap the reader.
  static unsigned char buf[16384];
  size_t held = 0;  // Bytes of a float split across two reads.
  uint64_t writeIndex = 0;
  for (;;) {
    ssize_t got = read(STDIN_FILENO, buf + held, sizeof(buf) - held);
    if (got == 0) break;  // Electron closed the pipe: phone mic stopped.
    if (got < 0) {
      if (errno == EINTR) continue;
      break;
    }
    // A pipe read ends wherever it likes, including mid-sample. Consuming only
    // whole floats and carrying the tail is the difference between clean audio
    // and every sample after the first split read being garbage.
    size_t total = held + (size_t)got;
    size_t count = total / sizeof(float);
    const float *samples = (const float *)buf;
    for (size_t i = 0; i < count; i++) {
      gRing->frames[(writeIndex + i) & MM_RING_MASK] = samples[i];
    }
    // Published only after the samples are in place, so the reader never sees
    // an index pointing at a frame that has not been written yet.
    writeIndex += count;
    gRing->write_index = writeIndex;

    held = total - count * sizeof(float);
    if (held > 0) memmove(buf, buf + count * sizeof(float), held);
  }

  MM_Cleanup();
  return 0;
}
