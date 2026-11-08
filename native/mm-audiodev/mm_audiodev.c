// mm-audiodev — a Core Audio Server Plug-In publishing "MightyMouse" as a
// microphone, fed by the phone's mic over a shared-memory ring.
//
// Why C and not Swift like every other helper here: coreaudiod loads this
// through a COM-style vtable of C function pointers, and its IO callbacks run
// on a realtime thread where Swift's runtime (ARC, allocation, exclusivity
// checks) is not permitted. Every other native/ helper is a normal process and
// has neither constraint.
//
// THE REALTIME RULE, which governs every line below the IO section: no malloc,
// no locks, no syscalls, no logging in the IO path. Violating it does not fail
// a test -- it produces intermittent clicks under load that are near-impossible
// to attribute later.

#include <CoreAudio/AudioServerPlugIn.h>
#include <fcntl.h>
#include <mach/mach_time.h>
#include <math.h>
#include <pthread.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <unistd.h>

#include "mm_audio_ring.h"
#include "mm_audiodev.h"

// The ring, mapped once at init. NULL means "no writer yet" -- the device still
// publishes and still runs, it just produces silence, which is what makes it
// selectable in ChatGPT before MightyMouse has ever sent a frame.
static MmAudioRing *gRing = NULL;
static int gRingFd = -1;
static uint64_t gReadIndex = 0;
static uint32_t gSeenGeneration = 0;

static pthread_mutex_t gStateMutex = PTHREAD_MUTEX_INITIALIZER;
static AudioServerPlugInHostRef gHost = NULL;
static UInt32 gIORunningCount = 0;

// Host time <-> sample time conversion, established at StartIO.
static Float64 gHostTicksPerFrame = 0.0;
static UInt64 gAnchorHostTime = 0;
static Float64 gAnchorSampleTime = 0.0;

#pragma mark - Ring attach

// Called off the realtime thread only (init / StartIO).
static void MM_AttachRing(void) {
  if (gRing != NULL) return;
  int fd = open(MM_RING_PATH, O_RDWR);
  if (fd < 0) return;
  // Mapping past EOF is legal but faults with SIGBUS on ACCESS -- which here
  // would land on the realtime IO thread and take coreaudiod down. A half-built
  // file (writer killed between create and ftruncate) is the case that hits.
  struct stat st;
  if (fstat(fd, &st) != 0 || (size_t)st.st_size < sizeof(MmAudioRing)) {
    close(fd);
    return;
  }
  void *map = mmap(NULL, sizeof(MmAudioRing), PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
  if (map == MAP_FAILED) {
    close(fd);
    return;
  }
  MmAudioRing *ring = (MmAudioRing *)map;
  // A stale plugin reading a newer layout would misinterpret every field, so
  // refuse rather than guess.
  if (ring->abi != MM_RING_ABI) {
    munmap(map, sizeof(MmAudioRing));
    close(fd);
    return;
  }
  gRingFd = fd;
  gRing = ring;
  gReadIndex = ring->write_index;
  gSeenGeneration = ring->generation;
}

#pragma mark - Plug-in driver interface

// Forward-declared so the driver ref below can point at it; the initializer is
// at the bottom, once every member function exists.
static AudioServerPlugInDriverInterface gDriverInterface;
static AudioServerPlugInDriverInterface *gDriverInterfacePtr = &gDriverInterface;
static AudioServerPlugInDriverRef gDriverRef = &gDriverInterfacePtr;
static UInt32 gRefCount = 0;

static HRESULT MM_QueryInterface(void *inDriver, REFIID inUUID, LPVOID *outInterface) {
  if (inDriver != gDriverRef || outInterface == NULL) return kAudioHardwareBadObjectError;
  CFUUIDRef uuid = CFUUIDCreateFromUUIDBytes(NULL, inUUID);
  if (uuid == NULL) return kAudioHardwareIllegalOperationError;
  CFUUIDRef want = CFUUIDGetConstantUUIDWithBytes(
      NULL, 0xEE, 0xA5, 0x77, 0x3D, 0xCC, 0x43, 0x49, 0xF1, 0x8E, 0x00, 0x8F, 0x96, 0xE7, 0xD2,
      0x3B, 0x17);
  CFUUIDRef base = CFUUIDGetConstantUUIDWithBytes(NULL, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
                                                  0x00, 0xC0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
                                                  0x46);
  Boolean ok = CFEqual(uuid, want) || CFEqual(uuid, base);
  CFRelease(uuid);
  if (!ok) return E_NOINTERFACE;
  ++gRefCount;
  *outInterface = gDriverRef;
  return 0;
}

static ULONG MM_AddRef(void *inDriver) {
  if (inDriver != gDriverRef) return 0;
  return ++gRefCount;
}

static ULONG MM_Release(void *inDriver) {
  if (inDriver != gDriverRef) return 0;
  if (gRefCount > 0) --gRefCount;
  return gRefCount;
}

static OSStatus MM_Initialize(AudioServerPlugInDriverRef inDriver,
                              AudioServerPlugInHostRef inHost) {
  if (inDriver != gDriverRef) return kAudioHardwareBadObjectError;
  gHost = inHost;
  MM_AttachRing();
  return 0;
}

// This device is not creatable/destroyable by the host, and has no settable
// non-realtime properties -- so every one of these is a hard no.
static OSStatus MM_CreateDevice(AudioServerPlugInDriverRef inDriver, CFDictionaryRef inDescription,
                                const AudioServerPlugInClientInfo *inClientInfo,
                                AudioObjectID *outDeviceObjectID) {
  (void)inDriver, (void)inDescription, (void)inClientInfo, (void)outDeviceObjectID;
  return kAudioHardwareUnsupportedOperationError;
}

static OSStatus MM_DestroyDevice(AudioServerPlugInDriverRef inDriver, AudioObjectID inDeviceID) {
  (void)inDriver, (void)inDeviceID;
  return kAudioHardwareUnsupportedOperationError;
}

static OSStatus MM_AddDeviceClient(AudioServerPlugInDriverRef inDriver, AudioObjectID inDeviceID,
                                   const AudioServerPlugInClientInfo *inClientInfo) {
  (void)inDriver, (void)inDeviceID, (void)inClientInfo;
  return 0;
}

static OSStatus MM_RemoveDeviceClient(AudioServerPlugInDriverRef inDriver, AudioObjectID inDeviceID,
                                      const AudioServerPlugInClientInfo *inClientInfo) {
  (void)inDriver, (void)inDeviceID, (void)inClientInfo;
  return 0;
}

static OSStatus MM_PerformDeviceConfigurationChange(AudioServerPlugInDriverRef inDriver,
                                                    AudioObjectID inDeviceID, UInt64 inChangeAction,
                                                    void *inChangeInfo) {
  (void)inDriver, (void)inDeviceID, (void)inChangeAction, (void)inChangeInfo;
  return 0;
}

static OSStatus MM_AbortDeviceConfigurationChange(AudioServerPlugInDriverRef inDriver,
                                                  AudioObjectID inDeviceID, UInt64 inChangeAction,
                                                  void *inChangeInfo) {
  (void)inDriver, (void)inDeviceID, (void)inChangeAction, (void)inChangeInfo;
  return 0;
}

#pragma mark - State the property table reads

static Float32 gVolumeScalar = 1.0f;

UInt32 MM_IsIORunning(void) { return gIORunningCount > 0 ? 1 : 0; }

Float32 MM_GetVolumeScalar(void) { return gVolumeScalar; }

void MM_SetVolumeScalar(Float32 scalar) { gVolumeScalar = scalar; }

// A 4th-power curve, the same shape Apple's own devices use: it puts the useful
// range in the top half of the slider instead of bunching it near the top.
Float32 MM_ScalarToDecibels(Float32 scalar) {
  if (scalar <= 0.0f) return (Float32)kVolume_MinDB;
  if (scalar >= 1.0f) return (Float32)kVolume_MaxDB;
  Float32 t = scalar * scalar * scalar * scalar;
  return (Float32)(kVolume_MinDB + t * (kVolume_MaxDB - kVolume_MinDB));
}

Float32 MM_DecibelsToScalar(Float32 db) {
  if (db <= (Float32)kVolume_MinDB) return 0.0f;
  if (db >= (Float32)kVolume_MaxDB) return 1.0f;
  Float32 t = (Float32)((db - kVolume_MinDB) / (kVolume_MaxDB - kVolume_MinDB));
  return sqrtf(sqrtf(t));
}

void MM_NotifyHost(AudioObjectID inObjectID, UInt32 inCount,
                   const AudioObjectPropertyAddress *inAddresses) {
  if (gHost == NULL) return;
  gHost->PropertiesChanged(gHost, inObjectID, inCount, inAddresses);
}

OSStatus MM_IsPropertySettable(AudioServerPlugInDriverRef inDriver, AudioObjectID inObjectID,
                               pid_t inClientPID, const AudioObjectPropertyAddress *inAddress,
                               Boolean *outIsSettable) {
  (void)inDriver, (void)inClientPID;
  if (inAddress == NULL || outIsSettable == NULL) return kAudioHardwareIllegalOperationError;
  // Only the input volume is writable; everything else describes fixed hardware.
  *outIsSettable = (inObjectID == kObjectID_Volume_Input &&
                    (inAddress->mSelector == kAudioLevelControlPropertyScalarValue ||
                     inAddress->mSelector == kAudioLevelControlPropertyDecibelValue));
  return 0;
}

#pragma mark - IO

static OSStatus MM_StartIO(AudioServerPlugInDriverRef inDriver, AudioObjectID inDeviceID,
                           UInt32 inClientID) {
  (void)inDriver, (void)inClientID;
  if (inDeviceID != kObjectID_Device) return kAudioHardwareBadObjectError;
  pthread_mutex_lock(&gStateMutex);
  if (gIORunningCount == 0) {
    // Late attach: MightyMouse may have started after coreaudiod loaded us.
    MM_AttachRing();
    struct mach_timebase_info tb;
    mach_timebase_info(&tb);
    Float64 hostTicksPerSecond = (1.0e9 * (Float64)tb.denom) / (Float64)tb.numer;
    gHostTicksPerFrame = hostTicksPerSecond / (Float64)MM_RING_SAMPLE_RATE;
    gAnchorHostTime = mach_absolute_time();
    gAnchorSampleTime = 0.0;
    if (gRing != NULL) {
      gReadIndex = gRing->write_index;
      gSeenGeneration = gRing->generation;
    }
  }
  ++gIORunningCount;
  pthread_mutex_unlock(&gStateMutex);
  return 0;
}

static OSStatus MM_StopIO(AudioServerPlugInDriverRef inDriver, AudioObjectID inDeviceID,
                          UInt32 inClientID) {
  (void)inDriver, (void)inClientID;
  if (inDeviceID != kObjectID_Device) return kAudioHardwareBadObjectError;
  pthread_mutex_lock(&gStateMutex);
  if (gIORunningCount > 0) --gIORunningCount;
  pthread_mutex_unlock(&gStateMutex);
  return 0;
}

// Realtime. Reports where the device "is" in its timeline so the host can pace
// reads. A free-running clock derived from mach_absolute_time keeps this device
// honest even when no audio is flowing.
static OSStatus MM_GetZeroTimeStamp(AudioServerPlugInDriverRef inDriver, AudioObjectID inDeviceID,
                                    UInt32 inClientID, Float64 *outSampleTime,
                                    UInt64 *outHostTime, UInt64 *outSeed) {
  (void)inDriver, (void)inClientID;
  if (inDeviceID != kObjectID_Device) return kAudioHardwareBadObjectError;

  UInt64 now = mach_absolute_time();
  Float64 elapsedFrames = (Float64)(now - gAnchorHostTime) / gHostTicksPerFrame;
  // Advance in whole ring-buffer periods; the host expects the zero timestamp to
  // step, not to slide continuously.
  Float64 periods = elapsedFrames / (Float64)MM_RING_CAPACITY_FRAMES;
  Float64 wholePeriods = (Float64)(UInt64)periods;

  if (outSampleTime != NULL) *outSampleTime = wholePeriods * (Float64)MM_RING_CAPACITY_FRAMES;
  if (outHostTime != NULL)
    *outHostTime =
        gAnchorHostTime + (UInt64)(wholePeriods * (Float64)MM_RING_CAPACITY_FRAMES * gHostTicksPerFrame);
  if (outSeed != NULL) *outSeed = 1;
  return 0;
}

static OSStatus MM_WillDoIOOperation(AudioServerPlugInDriverRef inDriver, AudioObjectID inDeviceID,
                                     UInt32 inClientID, UInt32 inOperationID, Boolean *outWillDo,
                                     Boolean *outWillDoInPlace) {
  (void)inDriver, (void)inClientID;
  if (inDeviceID != kObjectID_Device) return kAudioHardwareBadObjectError;
  // Input-only device: the single operation we implement is ReadInput.
  Boolean willDo = (inOperationID == kAudioServerPlugInIOOperationReadInput);
  if (outWillDo != NULL) *outWillDo = willDo;
  if (outWillDoInPlace != NULL) *outWillDoInPlace = true;
  return 0;
}

static OSStatus MM_BeginIOOperation(AudioServerPlugInDriverRef inDriver, AudioObjectID inDeviceID,
                                    UInt32 inClientID, UInt32 inOperationID, UInt32 inIOBufferFrameSize,
                                    const AudioServerPlugInIOCycleInfo *inIOCycleInfo) {
  (void)inDriver, (void)inDeviceID, (void)inClientID, (void)inOperationID, (void)inIOBufferFrameSize,
      (void)inIOCycleInfo;
  return 0;
}

// REALTIME THREAD. This is the whole point of the driver: hand ChatGPT whatever
// the phone most recently sent. No allocation, no locking, no logging here.
static OSStatus MM_DoIOOperation(AudioServerPlugInDriverRef inDriver, AudioObjectID inDeviceID,
                                 AudioObjectID inStreamObjectID, UInt32 inClientID,
                                 UInt32 inOperationID, UInt32 inIOBufferFrameSize,
                                 const AudioServerPlugInIOCycleInfo *inIOCycleInfo,
                                 void *ioMainBuffer, void *ioSecondaryBuffer) {
  (void)inDriver, (void)inStreamObjectID, (void)inClientID, (void)inIOCycleInfo,
      (void)ioSecondaryBuffer;
  if (inDeviceID != kObjectID_Device) return kAudioHardwareBadObjectError;
  if (inOperationID != kAudioServerPlugInIOOperationReadInput || ioMainBuffer == NULL) return 0;

  float *out = (float *)ioMainBuffer;
  const UInt32 wanted = inIOBufferFrameSize * MM_RING_CHANNELS;
  MmAudioRing *ring = gRing;

  // No writer, or the writer is idle (mic off) -> silence. Deliberately NOT an
  // error: a selected-but-muted mic is a normal state, and returning non-zero
  // here would make ChatGPT drop the device entirely.
  if (ring == NULL || ring->active == 0) {
    memset(out, 0, wanted * sizeof(float));
    return 0;
  }

  // A new session invalidates everything still queued from the old one.
  uint32_t gen = ring->generation;
  if (gen != gSeenGeneration) {
    gSeenGeneration = gen;
    gReadIndex = ring->write_index;
  }

  uint64_t writeIndex = ring->write_index;
  uint64_t available = (writeIndex > gReadIndex) ? (writeIndex - gReadIndex) : 0;

  // Overrun: the writer lapped us. Resync to the newest data rather than
  // playing out a whole buffer of stale audio -- in a voice call, being current
  // matters more than being complete.
  if (available > MM_RING_CAPACITY_FRAMES) {
    gReadIndex = writeIndex - MM_RING_CAPACITY_FRAMES;
    available = MM_RING_CAPACITY_FRAMES;
  }

  UInt32 toCopy = (available < inIOBufferFrameSize) ? (UInt32)available : inIOBufferFrameSize;
  for (UInt32 i = 0; i < toCopy; i++) {
    out[i] = ring->frames[(gReadIndex + i) & MM_RING_MASK];
  }
  // Underrun: pad with silence. A gap is the correct failure -- stretching or
  // repeating would sound worse and desync the timeline.
  if (toCopy < inIOBufferFrameSize) {
    memset(out + toCopy, 0, (inIOBufferFrameSize - toCopy) * sizeof(float));
  }
  gReadIndex += toCopy;
  return 0;
}

static OSStatus MM_EndIOOperation(AudioServerPlugInDriverRef inDriver, AudioObjectID inDeviceID,
                                  UInt32 inClientID, UInt32 inOperationID,
                                  UInt32 inIOBufferFrameSize,
                                  const AudioServerPlugInIOCycleInfo *inIOCycleInfo) {
  (void)inDriver, (void)inDeviceID, (void)inClientID, (void)inOperationID, (void)inIOBufferFrameSize,
      (void)inIOCycleInfo;
  return 0;
}

#pragma mark - Entry point

static AudioServerPlugInDriverInterface gDriverInterface = {
    NULL,  // _reserved
    MM_QueryInterface,
    MM_AddRef,
    MM_Release,
    MM_Initialize,
    MM_CreateDevice,
    MM_DestroyDevice,
    MM_AddDeviceClient,
    MM_RemoveDeviceClient,
    MM_PerformDeviceConfigurationChange,
    MM_AbortDeviceConfigurationChange,
    MM_HasProperty,
    MM_IsPropertySettable,
    MM_GetPropertyDataSize,
    MM_GetPropertyData,
    MM_SetPropertyData,
    MM_StartIO,
    MM_StopIO,
    MM_GetZeroTimeStamp,
    MM_WillDoIOOperation,
    MM_BeginIOOperation,
    MM_DoIOOperation,
    MM_EndIOOperation};

// Named in Info.plist's CFPlugInFactories. coreaudiod calls this to get the
// vtable above. The plist's factory key must stay in sync with that entry --
// a mismatch loads nothing and reports no error.
void *MmAudioDevFactory(CFAllocatorRef inAllocator, CFUUIDRef inRequestedTypeUUID) {
  (void)inAllocator;
  if (inRequestedTypeUUID == NULL) return NULL;
  if (CFEqual(inRequestedTypeUUID, kAudioServerPlugInTypeUUID)) return gDriverRef;
  return NULL;
}
