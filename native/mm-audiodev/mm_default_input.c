// mm-default-input — read or set the Mac's default audio INPUT device.
//
// Exists so turning the phone mic on can point the Mac at it without sending
// the user to System Settings. Core Audio exposes this with no permission
// prompt and no admin: it is the same call the Sound pane makes.
//
// Usage:
//   mm-default-input get           -> prints the current device's UID
//   mm-default-input set <uid>     -> selects it; exit 0 on success
//   mm-default-input set-name <s>  -> selects by device NAME (first match)
//
// UIDs are the durable handle -- a name can be duplicated (two "USB Audio")
// and is localised. set-name exists only because the HAL plugin's UID is an
// implementation detail of the driver, while its name is a product decision.

#include <CoreAudio/CoreAudio.h>
#include <CoreFoundation/CoreFoundation.h>
#include <stdio.h>
#include <string.h>

static const AudioObjectPropertyAddress kDefaultInput = {
    kAudioHardwarePropertyDefaultInputDevice, kAudioObjectPropertyScopeGlobal,
    kAudioObjectPropertyElementMain};

/** Copy a device's UID or name into `out`. Returns 0 on success. */
static int MM_CopyString(AudioObjectID device, AudioObjectPropertySelector sel, char *out,
                         size_t out_len) {
  AudioObjectPropertyAddress addr = {sel, kAudioObjectPropertyScopeGlobal,
                                     kAudioObjectPropertyElementMain};
  CFStringRef str = NULL;
  UInt32 size = sizeof(str);
  if (AudioObjectGetPropertyData(device, &addr, 0, NULL, &size, &str) != noErr || str == NULL) {
    return 1;
  }
  Boolean ok = CFStringGetCString(str, out, (CFIndex)out_len, kCFStringEncodingUTF8);
  CFRelease(str);
  return ok ? 0 : 1;
}

/** All device ids. Caller frees. Returns count, or 0 on failure. */
static UInt32 MM_CopyDevices(AudioObjectID **out) {
  AudioObjectPropertyAddress addr = {kAudioHardwarePropertyDevices,
                                     kAudioObjectPropertyScopeGlobal,
                                     kAudioObjectPropertyElementMain};
  UInt32 size = 0;
  if (AudioObjectGetPropertyDataSize(kAudioObjectSystemObject, &addr, 0, NULL, &size) != noErr) {
    return 0;
  }
  UInt32 count = size / sizeof(AudioObjectID);
  AudioObjectID *ids = (AudioObjectID *)malloc(size);
  if (ids == NULL) return 0;
  if (AudioObjectGetPropertyData(kAudioObjectSystemObject, &addr, 0, NULL, &size, ids) != noErr) {
    free(ids);
    return 0;
  }
  *out = ids;
  return count;
}

/** True if the device has at least one input channel. A Mac's output-only
 *  devices appear in the same list, and selecting one as the default INPUT
 *  silently succeeds while capturing nothing. */
static int MM_HasInput(AudioObjectID device) {
  AudioObjectPropertyAddress addr = {kAudioDevicePropertyStreamConfiguration,
                                     kAudioObjectPropertyScopeInput,
                                     kAudioObjectPropertyElementMain};
  UInt32 size = 0;
  if (AudioObjectGetPropertyDataSize(device, &addr, 0, NULL, &size) != noErr || size == 0) {
    return 0;
  }
  AudioBufferList *list = (AudioBufferList *)malloc(size);
  if (list == NULL) return 0;
  int channels = 0;
  if (AudioObjectGetPropertyData(device, &addr, 0, NULL, &size, list) == noErr) {
    for (UInt32 i = 0; i < list->mNumberBuffers; i++) {
      channels += list->mBuffers[i].mNumberChannels;
    }
  }
  free(list);
  return channels > 0;
}

/** Find an input device whose UID (or name, when `by_name`) matches. Returns
 *  kAudioObjectUnknown when absent -- the normal case for a saved device that
 *  has since been unplugged. */
static AudioObjectID MM_Find(const char *needle, int by_name) {
  AudioObjectID *ids = NULL;
  UInt32 count = MM_CopyDevices(&ids);
  AudioObjectID found = kAudioObjectUnknown;
  for (UInt32 i = 0; i < count; i++) {
    if (!MM_HasInput(ids[i])) continue;
    char buf[512] = {0};
    AudioObjectPropertySelector sel =
        by_name ? kAudioObjectPropertyName : kAudioDevicePropertyDeviceUID;
    if (MM_CopyString(ids[i], sel, buf, sizeof(buf)) != 0) continue;
    if (strcmp(buf, needle) == 0) {
      found = ids[i];
      break;
    }
  }
  free(ids);
  return found;
}

static int MM_Set(AudioObjectID device) {
  OSStatus err = AudioObjectSetPropertyData(kAudioObjectSystemObject, &kDefaultInput, 0, NULL,
                                            sizeof(device), &device);
  if (err != noErr) {
    fprintf(stderr, "mm-default-input: set failed (%d)\n", (int)err);
    return 1;
  }
  return 0;
}

int main(int argc, char **argv) {
  if (argc >= 2 && strcmp(argv[1], "get") == 0) {
    AudioObjectID device = kAudioObjectUnknown;
    UInt32 size = sizeof(device);
    if (AudioObjectGetPropertyData(kAudioObjectSystemObject, &kDefaultInput, 0, NULL, &size,
                                   &device) != noErr) {
      fprintf(stderr, "mm-default-input: cannot read default input\n");
      return 1;
    }
    char uid[512] = {0};
    if (MM_CopyString(device, kAudioDevicePropertyDeviceUID, uid, sizeof(uid)) != 0) return 1;
    printf("%s\n", uid);
    return 0;
  }

  int by_name = argc >= 3 && strcmp(argv[1], "set-name") == 0;
  if (argc >= 3 && (by_name || strcmp(argv[1], "set") == 0)) {
    AudioObjectID device = MM_Find(argv[2], by_name);
    if (device == kAudioObjectUnknown) {
      // Exit 2, not 1: "that device is gone" is an expected outcome the caller
      // handles (leave the input alone), not a failure worth logging loudly.
      fprintf(stderr, "mm-default-input: no input device matching '%s'\n", argv[2]);
      return 2;
    }
    return MM_Set(device);
  }

  fprintf(stderr, "usage: mm-default-input get | set <uid> | set-name <name>\n");
  return 1;
}
