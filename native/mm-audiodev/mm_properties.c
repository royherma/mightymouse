// The property table -- everything coreaudiod asks about the device, and the
// half that decides whether "MightyMouse" appears in ChatGPT's mic list at all.
//
// Split from mm_audiodev.c only because a HAL plugin's property switch is
// unavoidably long: four objects x ~15 selectors, each a near-identical
// bounds-check-then-write. Nothing here runs on the realtime thread.
//
// The contract that is easy to get wrong: GetPropertyDataSize and
// GetPropertyData must agree on every selector. Disagree and the host either
// truncates the value or reads past the buffer -- and the symptom is a device
// that silently fails to enumerate, with no error anywhere.

#include <CoreAudio/AudioHardware.h>
#include <CoreAudio/AudioServerPlugIn.h>
#include <string.h>

#include "mm_audio_ring.h"
#include "mm_audiodev.h"

// Writes a value of known size, after checking the caller's buffer can hold it.
#define MM_RETURN(type, expr)                                  \
  do {                                                         \
    if (inDataSize < sizeof(type)) return kAudioHardwareBadPropertySizeError; \
    *((type *)outData) = (expr);                               \
    *outDataSize = sizeof(type);                               \
    return 0;                                                  \
  } while (0)

static void MM_FillStreamFormat(AudioStreamBasicDescription *f) {
  f->mSampleRate = (Float64)MM_RING_SAMPLE_RATE;
  f->mFormatID = kAudioFormatLinearPCM;
  f->mFormatFlags = kAudioFormatFlagIsFloat | kAudioFormatFlagsNativeEndian |
                    kAudioFormatFlagIsPacked;
  f->mBytesPerPacket = 4 * MM_RING_CHANNELS;
  f->mFramesPerPacket = 1;
  f->mBytesPerFrame = 4 * MM_RING_CHANNELS;
  f->mChannelsPerFrame = MM_RING_CHANNELS;
  f->mBitsPerChannel = 32;
  f->mReserved = 0;
}

Boolean MM_HasProperty(AudioServerPlugInDriverRef inDriver, AudioObjectID inObjectID,
                       pid_t inClientPID, const AudioObjectPropertyAddress *inAddress) {
  (void)inDriver, (void)inClientPID;
  if (inAddress == NULL) return false;
  // Cheapest correct implementation: ask GetPropertyDataSize, which already
  // enumerates every selector we answer. Keeping a second hand-written list in
  // sync with that switch is exactly how a device goes missing.
  UInt32 size = 0;
  return MM_GetPropertyDataSize(inDriver, inObjectID, inClientPID, inAddress, 0, NULL, &size) == 0;
}

OSStatus MM_GetPropertyDataSize(AudioServerPlugInDriverRef inDriver, AudioObjectID inObjectID,
                                pid_t inClientPID, const AudioObjectPropertyAddress *inAddress,
                                UInt32 inQualifierDataSize, const void *inQualifierData,
                                UInt32 *outDataSize) {
  (void)inDriver, (void)inClientPID, (void)inQualifierDataSize, (void)inQualifierData;
  if (inAddress == NULL || outDataSize == NULL) return kAudioHardwareIllegalOperationError;

  switch (inObjectID) {
    case kObjectID_PlugIn:
      switch (inAddress->mSelector) {
        case kAudioObjectPropertyBaseClass:
        case kAudioObjectPropertyClass:
          *outDataSize = sizeof(AudioClassID);
          return 0;
        case kAudioObjectPropertyOwner:
          *outDataSize = sizeof(AudioObjectID);
          return 0;
        case kAudioObjectPropertyManufacturer:
          *outDataSize = sizeof(CFStringRef);
          return 0;
        case kAudioObjectPropertyOwnedObjects:
        case kAudioPlugInPropertyDeviceList:
          *outDataSize = sizeof(AudioObjectID);
          return 0;
        case kAudioPlugInPropertyTranslateUIDToDevice:
          *outDataSize = sizeof(AudioObjectID);
          return 0;
        case kAudioPlugInPropertyResourceBundle:
          *outDataSize = sizeof(CFStringRef);
          return 0;
      }
      return kAudioHardwareUnknownPropertyError;

    case kObjectID_Device:
      switch (inAddress->mSelector) {
        case kAudioObjectPropertyBaseClass:
        case kAudioObjectPropertyClass:
          *outDataSize = sizeof(AudioClassID);
          return 0;
        case kAudioObjectPropertyOwner:
          *outDataSize = sizeof(AudioObjectID);
          return 0;
        case kAudioObjectPropertyName:
        case kAudioObjectPropertyManufacturer:
        case kAudioDevicePropertyDeviceUID:
        case kAudioDevicePropertyModelUID:
          *outDataSize = sizeof(CFStringRef);
          return 0;
        case kAudioObjectPropertyOwnedObjects:
          // The input stream plus its volume control.
          *outDataSize = 2 * sizeof(AudioObjectID);
          return 0;
        case kAudioDevicePropertyStreams:
          // Input-only device, so the output scope has no streams at all.
          *outDataSize =
              (inAddress->mScope == kAudioObjectPropertyScopeOutput) ? 0 : sizeof(AudioObjectID);
          return 0;
        case kAudioObjectPropertyControlList:
          *outDataSize = sizeof(AudioObjectID);
          return 0;
        case kAudioDevicePropertyTransportType:
        case kAudioDevicePropertyClockDomain:
        case kAudioDevicePropertyDeviceIsAlive:
        case kAudioDevicePropertyDeviceIsRunning:
        case kAudioDevicePropertyDeviceCanBeDefaultDevice:
        case kAudioDevicePropertyDeviceCanBeDefaultSystemDevice:
        case kAudioDevicePropertyLatency:
        case kAudioDevicePropertySafetyOffset:
        case kAudioDevicePropertyZeroTimeStampPeriod:
        case kAudioDevicePropertyIsHidden:
          *outDataSize = sizeof(UInt32);
          return 0;
        case kAudioDevicePropertyNominalSampleRate:
          *outDataSize = sizeof(Float64);
          return 0;
        case kAudioDevicePropertyAvailableNominalSampleRates:
          *outDataSize = sizeof(AudioValueRange);
          return 0;
        case kAudioDevicePropertyPreferredChannelsForStereo:
          *outDataSize = 2 * sizeof(UInt32);
          return 0;
        case kAudioDevicePropertyStreamConfiguration:
          *outDataSize = offsetof(AudioBufferList, mBuffers) + sizeof(AudioBuffer);
          return 0;
        case kAudioDevicePropertyPreferredChannelLayout:
          *outDataSize = offsetof(AudioChannelLayout, mChannelDescriptions) +
                         sizeof(AudioChannelDescription);
          return 0;
      }
      return kAudioHardwareUnknownPropertyError;

    case kObjectID_Stream_Input:
      switch (inAddress->mSelector) {
        case kAudioObjectPropertyBaseClass:
        case kAudioObjectPropertyClass:
          *outDataSize = sizeof(AudioClassID);
          return 0;
        case kAudioObjectPropertyOwner:
          *outDataSize = sizeof(AudioObjectID);
          return 0;
        case kAudioObjectPropertyOwnedObjects:
          *outDataSize = 0;
          return 0;
        case kAudioStreamPropertyIsActive:
        case kAudioStreamPropertyDirection:
        case kAudioStreamPropertyTerminalType:
        case kAudioStreamPropertyStartingChannel:
        case kAudioStreamPropertyLatency:
          *outDataSize = sizeof(UInt32);
          return 0;
        case kAudioStreamPropertyVirtualFormat:
        case kAudioStreamPropertyPhysicalFormat:
          *outDataSize = sizeof(AudioStreamBasicDescription);
          return 0;
        case kAudioStreamPropertyAvailableVirtualFormats:
        case kAudioStreamPropertyAvailablePhysicalFormats:
          *outDataSize = sizeof(AudioStreamRangedDescription);
          return 0;
      }
      return kAudioHardwareUnknownPropertyError;

    case kObjectID_Volume_Input:
      switch (inAddress->mSelector) {
        case kAudioObjectPropertyBaseClass:
        case kAudioObjectPropertyClass:
          *outDataSize = sizeof(AudioClassID);
          return 0;
        case kAudioObjectPropertyOwner:
          *outDataSize = sizeof(AudioObjectID);
          return 0;
        case kAudioObjectPropertyOwnedObjects:
          *outDataSize = 0;
          return 0;
        case kAudioControlPropertyScope:
          *outDataSize = sizeof(AudioObjectPropertyScope);
          return 0;
        case kAudioControlPropertyElement:
          *outDataSize = sizeof(AudioObjectPropertyElement);
          return 0;
        case kAudioLevelControlPropertyScalarValue:
        case kAudioLevelControlPropertyDecibelValue:
          *outDataSize = sizeof(Float32);
          return 0;
        case kAudioLevelControlPropertyDecibelRange:
          *outDataSize = sizeof(AudioValueRange);
          return 0;
        case kAudioLevelControlPropertyConvertScalarToDecibels:
        case kAudioLevelControlPropertyConvertDecibelsToScalar:
          *outDataSize = sizeof(Float32);
          return 0;
      }
      return kAudioHardwareUnknownPropertyError;
  }
  return kAudioHardwareBadObjectError;
}

OSStatus MM_GetPropertyData(AudioServerPlugInDriverRef inDriver, AudioObjectID inObjectID,
                            pid_t inClientPID, const AudioObjectPropertyAddress *inAddress,
                            UInt32 inQualifierDataSize, const void *inQualifierData,
                            UInt32 inDataSize, UInt32 *outDataSize, void *outData) {
  (void)inDriver, (void)inClientPID;
  if (inAddress == NULL || outDataSize == NULL || outData == NULL)
    return kAudioHardwareIllegalOperationError;

  switch (inObjectID) {
    case kObjectID_PlugIn:
      switch (inAddress->mSelector) {
        case kAudioObjectPropertyBaseClass:
          MM_RETURN(AudioClassID, kAudioObjectClassID);
        case kAudioObjectPropertyClass:
          MM_RETURN(AudioClassID, kAudioPlugInClassID);
        case kAudioObjectPropertyOwner:
          MM_RETURN(AudioObjectID, kAudioObjectUnknown);
        case kAudioObjectPropertyManufacturer:
          MM_RETURN(CFStringRef, CFSTR(kDevice_Manufacturer));
        case kAudioObjectPropertyOwnedObjects:
        case kAudioPlugInPropertyDeviceList:
          if (inDataSize < sizeof(AudioObjectID)) {
            *outDataSize = 0;
            return 0;
          }
          *((AudioObjectID *)outData) = kObjectID_Device;
          *outDataSize = sizeof(AudioObjectID);
          return 0;
        case kAudioPlugInPropertyTranslateUIDToDevice: {
          if (inQualifierDataSize != sizeof(CFStringRef) || inQualifierData == NULL)
            return kAudioHardwareBadPropertySizeError;
          CFStringRef uid = *((const CFStringRef *)inQualifierData);
          MM_RETURN(AudioObjectID, (uid != NULL && CFStringCompare(uid, CFSTR(kDevice_UID), 0) ==
                                                       kCFCompareEqualTo)
                                       ? (AudioObjectID)kObjectID_Device
                                       : (AudioObjectID)kAudioObjectUnknown);
        }
        case kAudioPlugInPropertyResourceBundle:
          // Empty string means "the plugin bundle itself" -- we ship no
          // localized resources.
          MM_RETURN(CFStringRef, CFSTR(""));
      }
      return kAudioHardwareUnknownPropertyError;

    case kObjectID_Device:
      switch (inAddress->mSelector) {
        case kAudioObjectPropertyBaseClass:
          MM_RETURN(AudioClassID, kAudioObjectClassID);
        case kAudioObjectPropertyClass:
          MM_RETURN(AudioClassID, kAudioDeviceClassID);
        case kAudioObjectPropertyOwner:
          MM_RETURN(AudioObjectID, kObjectID_PlugIn);
        case kAudioObjectPropertyName:
          MM_RETURN(CFStringRef, CFSTR(kDevice_Name));
        case kAudioObjectPropertyManufacturer:
          MM_RETURN(CFStringRef, CFSTR(kDevice_Manufacturer));
        case kAudioDevicePropertyDeviceUID:
        case kAudioDevicePropertyModelUID:
          MM_RETURN(CFStringRef, CFSTR(kDevice_UID));
        case kAudioObjectPropertyOwnedObjects: {
          const AudioObjectID owned[2] = {kObjectID_Stream_Input, kObjectID_Volume_Input};
          UInt32 n = inDataSize / sizeof(AudioObjectID);
          if (n > 2) n = 2;
          memcpy(outData, owned, n * sizeof(AudioObjectID));
          *outDataSize = n * sizeof(AudioObjectID);
          return 0;
        }
        case kAudioDevicePropertyStreams: {
          // Output scope is genuinely empty -- this is an input-only device,
          // which is what keeps it out of the Sound output list.
          if (inAddress->mScope == kAudioObjectPropertyScopeOutput) {
            *outDataSize = 0;
            return 0;
          }
          if (inDataSize < sizeof(AudioObjectID)) {
            *outDataSize = 0;
            return 0;
          }
          *((AudioObjectID *)outData) = kObjectID_Stream_Input;
          *outDataSize = sizeof(AudioObjectID);
          return 0;
        }
        case kAudioObjectPropertyControlList: {
          if (inDataSize < sizeof(AudioObjectID)) {
            *outDataSize = 0;
            return 0;
          }
          *((AudioObjectID *)outData) = kObjectID_Volume_Input;
          *outDataSize = sizeof(AudioObjectID);
          return 0;
        }
        case kAudioDevicePropertyTransportType:
          // Virtual, not USB/BuiltIn -- the Sound pane groups by this, and
          // claiming BuiltIn would let macOS treat it as the internal mic.
          MM_RETURN(UInt32, kAudioDeviceTransportTypeVirtual);
        case kAudioDevicePropertyClockDomain:
          MM_RETURN(UInt32, 0);
        case kAudioDevicePropertyDeviceIsAlive:
          MM_RETURN(UInt32, 1);
        case kAudioDevicePropertyDeviceIsRunning:
          MM_RETURN(UInt32, MM_IsIORunning());
        case kAudioDevicePropertyDeviceCanBeDefaultDevice:
          MM_RETURN(UInt32, 1);
        case kAudioDevicePropertyDeviceCanBeDefaultSystemDevice:
          // Alerts and system sounds should never route through the phone.
          MM_RETURN(UInt32, 0);
        case kAudioDevicePropertyLatency:
          MM_RETURN(UInt32, 0);
        case kAudioDevicePropertySafetyOffset:
          MM_RETURN(UInt32, 0);
        case kAudioDevicePropertyNominalSampleRate:
          MM_RETURN(Float64, (Float64)MM_RING_SAMPLE_RATE);
        case kAudioDevicePropertyAvailableNominalSampleRates: {
          // Exactly one rate. Advertising a range would invite the host to pick
          // something the ring cannot produce, and nothing here resamples.
          if (inDataSize < sizeof(AudioValueRange)) {
            *outDataSize = 0;
            return 0;
          }
          AudioValueRange *r = (AudioValueRange *)outData;
          r->mMinimum = (Float64)MM_RING_SAMPLE_RATE;
          r->mMaximum = (Float64)MM_RING_SAMPLE_RATE;
          *outDataSize = sizeof(AudioValueRange);
          return 0;
        }
        case kAudioDevicePropertyPreferredChannelsForStereo: {
          if (inDataSize < 2 * sizeof(UInt32)) return kAudioHardwareBadPropertySizeError;
          ((UInt32 *)outData)[0] = 1;
          ((UInt32 *)outData)[1] = MM_RING_CHANNELS;
          *outDataSize = 2 * sizeof(UInt32);
          return 0;
        }
        case kAudioDevicePropertyStreamConfiguration: {
          const UInt32 need = offsetof(AudioBufferList, mBuffers) + sizeof(AudioBuffer);
          if (inDataSize < need) return kAudioHardwareBadPropertySizeError;
          AudioBufferList *bl = (AudioBufferList *)outData;
          if (inAddress->mScope == kAudioObjectPropertyScopeOutput) {
            bl->mNumberBuffers = 0;
            *outDataSize = offsetof(AudioBufferList, mBuffers);
            return 0;
          }
          bl->mNumberBuffers = 1;
          bl->mBuffers[0].mNumberChannels = MM_RING_CHANNELS;
          bl->mBuffers[0].mDataByteSize = 0;
          bl->mBuffers[0].mData = NULL;
          *outDataSize = need;
          return 0;
        }
        case kAudioDevicePropertyPreferredChannelLayout: {
          const UInt32 need =
              offsetof(AudioChannelLayout, mChannelDescriptions) + sizeof(AudioChannelDescription);
          if (inDataSize < need) return kAudioHardwareBadPropertySizeError;
          AudioChannelLayout *l = (AudioChannelLayout *)outData;
          memset(l, 0, need);
          l->mChannelLayoutTag = kAudioChannelLayoutTag_UseChannelDescriptions;
          l->mNumberChannelDescriptions = MM_RING_CHANNELS;
          l->mChannelDescriptions[0].mChannelLabel = kAudioChannelLabel_Mono;
          *outDataSize = need;
          return 0;
        }
        case kAudioDevicePropertyZeroTimeStampPeriod:
          MM_RETURN(UInt32, MM_RING_CAPACITY_FRAMES);
        case kAudioDevicePropertyIsHidden:
          MM_RETURN(UInt32, 0);
      }
      return kAudioHardwareUnknownPropertyError;

    case kObjectID_Stream_Input:
      switch (inAddress->mSelector) {
        case kAudioObjectPropertyBaseClass:
          MM_RETURN(AudioClassID, kAudioObjectClassID);
        case kAudioObjectPropertyClass:
          MM_RETURN(AudioClassID, kAudioStreamClassID);
        case kAudioObjectPropertyOwner:
          MM_RETURN(AudioObjectID, kObjectID_Device);
        case kAudioObjectPropertyOwnedObjects:
          *outDataSize = 0;
          return 0;
        case kAudioStreamPropertyIsActive:
          MM_RETURN(UInt32, 1);
        case kAudioStreamPropertyDirection:
          // 1 = input. This one value is why ChatGPT lists it as a microphone.
          MM_RETURN(UInt32, 1);
        case kAudioStreamPropertyTerminalType:
          MM_RETURN(UInt32, kAudioStreamTerminalTypeMicrophone);
        case kAudioStreamPropertyStartingChannel:
          MM_RETURN(UInt32, 1);
        case kAudioStreamPropertyLatency:
          MM_RETURN(UInt32, 0);
        case kAudioStreamPropertyVirtualFormat:
        case kAudioStreamPropertyPhysicalFormat: {
          if (inDataSize < sizeof(AudioStreamBasicDescription))
            return kAudioHardwareBadPropertySizeError;
          MM_FillStreamFormat((AudioStreamBasicDescription *)outData);
          *outDataSize = sizeof(AudioStreamBasicDescription);
          return 0;
        }
        case kAudioStreamPropertyAvailableVirtualFormats:
        case kAudioStreamPropertyAvailablePhysicalFormats: {
          if (inDataSize < sizeof(AudioStreamRangedDescription)) {
            *outDataSize = 0;
            return 0;
          }
          AudioStreamRangedDescription *d = (AudioStreamRangedDescription *)outData;
          MM_FillStreamFormat(&d->mFormat);
          d->mSampleRateRange.mMinimum = (Float64)MM_RING_SAMPLE_RATE;
          d->mSampleRateRange.mMaximum = (Float64)MM_RING_SAMPLE_RATE;
          *outDataSize = sizeof(AudioStreamRangedDescription);
          return 0;
        }
      }
      return kAudioHardwareUnknownPropertyError;

    case kObjectID_Volume_Input:
      switch (inAddress->mSelector) {
        case kAudioObjectPropertyBaseClass:
          MM_RETURN(AudioClassID, kAudioLevelControlClassID);
        case kAudioObjectPropertyClass:
          MM_RETURN(AudioClassID, kAudioVolumeControlClassID);
        case kAudioObjectPropertyOwner:
          MM_RETURN(AudioObjectID, kObjectID_Device);
        case kAudioObjectPropertyOwnedObjects:
          *outDataSize = 0;
          return 0;
        case kAudioControlPropertyScope:
          MM_RETURN(AudioObjectPropertyScope, kAudioObjectPropertyScopeInput);
        case kAudioControlPropertyElement:
          MM_RETURN(AudioObjectPropertyElement, kAudioObjectPropertyElementMain);
        case kAudioLevelControlPropertyScalarValue:
          MM_RETURN(Float32, MM_GetVolumeScalar());
        case kAudioLevelControlPropertyDecibelValue:
          MM_RETURN(Float32, MM_ScalarToDecibels(MM_GetVolumeScalar()));
        case kAudioLevelControlPropertyDecibelRange: {
          if (inDataSize < sizeof(AudioValueRange)) return kAudioHardwareBadPropertySizeError;
          AudioValueRange *r = (AudioValueRange *)outData;
          r->mMinimum = kVolume_MinDB;
          r->mMaximum = kVolume_MaxDB;
          *outDataSize = sizeof(AudioValueRange);
          return 0;
        }
        case kAudioLevelControlPropertyConvertScalarToDecibels: {
          if (inDataSize < sizeof(Float32)) return kAudioHardwareBadPropertySizeError;
          *((Float32 *)outData) = MM_ScalarToDecibels(*((Float32 *)outData));
          *outDataSize = sizeof(Float32);
          return 0;
        }
        case kAudioLevelControlPropertyConvertDecibelsToScalar: {
          if (inDataSize < sizeof(Float32)) return kAudioHardwareBadPropertySizeError;
          *((Float32 *)outData) = MM_DecibelsToScalar(*((Float32 *)outData));
          *outDataSize = sizeof(Float32);
          return 0;
        }
      }
      return kAudioHardwareUnknownPropertyError;
  }
  return kAudioHardwareBadObjectError;
}

OSStatus MM_SetPropertyData(AudioServerPlugInDriverRef inDriver, AudioObjectID inObjectID,
                            pid_t inClientPID, const AudioObjectPropertyAddress *inAddress,
                            UInt32 inQualifierDataSize, const void *inQualifierData,
                            UInt32 inDataSize, const void *inData) {
  (void)inDriver, (void)inClientPID, (void)inQualifierDataSize, (void)inQualifierData;
  if (inAddress == NULL || inData == NULL) return kAudioHardwareIllegalOperationError;

  // Input volume is the only writable property; see MM_IsPropertySettable.
  if (inObjectID == kObjectID_Volume_Input) {
    Float32 scalar;
    if (inAddress->mSelector == kAudioLevelControlPropertyScalarValue) {
      if (inDataSize < sizeof(Float32)) return kAudioHardwareBadPropertySizeError;
      scalar = *((const Float32 *)inData);
    } else if (inAddress->mSelector == kAudioLevelControlPropertyDecibelValue) {
      if (inDataSize < sizeof(Float32)) return kAudioHardwareBadPropertySizeError;
      scalar = MM_DecibelsToScalar(*((const Float32 *)inData));
    } else {
      return kAudioHardwareUnknownPropertyError;
    }
    if (scalar < 0.0f) scalar = 0.0f;
    if (scalar > 1.0f) scalar = 1.0f;
    MM_SetVolumeScalar(scalar);
    // The host must be told, or a change made in one app never reaches the
    // Sound pane's slider.
    const AudioObjectPropertyAddress changed[2] = {
        {kAudioLevelControlPropertyScalarValue, kAudioObjectPropertyScopeGlobal,
         kAudioObjectPropertyElementMain},
        {kAudioLevelControlPropertyDecibelValue, kAudioObjectPropertyScopeGlobal,
         kAudioObjectPropertyElementMain}};
    MM_NotifyHost(kObjectID_Volume_Input, 2, changed);
    return 0;
  }
  return kAudioHardwareUnknownPropertyError;
}
