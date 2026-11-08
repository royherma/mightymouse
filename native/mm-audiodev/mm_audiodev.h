// Shared between the driver core (mm_audiodev.c) and the property table
// (mm_properties.c). Internal to the plugin -- nothing outside the bundle
// includes this; the writer side's contract is mm_audio_ring.h.

#ifndef MM_AUDIODEV_H
#define MM_AUDIODEV_H

#include <CoreAudio/AudioServerPlugIn.h>

// Object IDs. The plugin is always 1 (kAudioObjectPlugInObject); the rest are
// ours to choose and must stay stable for the life of the process.
enum {
  kObjectID_PlugIn = kAudioObjectPlugInObject,
  kObjectID_Device = 2,
  kObjectID_Stream_Input = 3,
  kObjectID_Volume_Input = 4
};

#define kDevice_UID "com.mightymouse.audiodev.phone-mic"
#define kDevice_Name "MightyMouse"
#define kDevice_Manufacturer "MightyMouse"

#define kVolume_MinDB (-96.0)
#define kVolume_MaxDB (0.0)

Boolean MM_HasProperty(AudioServerPlugInDriverRef inDriver, AudioObjectID inObjectID,
                       pid_t inClientPID, const AudioObjectPropertyAddress *inAddress);
OSStatus MM_IsPropertySettable(AudioServerPlugInDriverRef inDriver, AudioObjectID inObjectID,
                               pid_t inClientPID, const AudioObjectPropertyAddress *inAddress,
                               Boolean *outIsSettable);
OSStatus MM_GetPropertyDataSize(AudioServerPlugInDriverRef inDriver, AudioObjectID inObjectID,
                                pid_t inClientPID, const AudioObjectPropertyAddress *inAddress,
                                UInt32 inQualifierDataSize, const void *inQualifierData,
                                UInt32 *outDataSize);
OSStatus MM_GetPropertyData(AudioServerPlugInDriverRef inDriver, AudioObjectID inObjectID,
                            pid_t inClientPID, const AudioObjectPropertyAddress *inAddress,
                            UInt32 inQualifierDataSize, const void *inQualifierData,
                            UInt32 inDataSize, UInt32 *outDataSize, void *outData);
OSStatus MM_SetPropertyData(AudioServerPlugInDriverRef inDriver, AudioObjectID inObjectID,
                            pid_t inClientPID, const AudioObjectPropertyAddress *inAddress,
                            UInt32 inQualifierDataSize, const void *inQualifierData,
                            UInt32 inDataSize, const void *inData);

// Owned by mm_audiodev.c; the property table only reads/writes through these.
UInt32 MM_IsIORunning(void);
Float32 MM_GetVolumeScalar(void);
void MM_SetVolumeScalar(Float32 scalar);
Float32 MM_ScalarToDecibels(Float32 scalar);
Float32 MM_DecibelsToScalar(Float32 db);
void MM_NotifyHost(AudioObjectID inObjectID, UInt32 inCount,
                   const AudioObjectPropertyAddress *inAddresses);

#endif
