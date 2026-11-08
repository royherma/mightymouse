#include <napi.h>
#import <AppKit/AppKit.h>
#import <AuthenticationServices/AuthenticationServices.h>

static NSData *DataFromBase64Url(NSString *s) {
  NSString *b64 = [[s stringByReplacingOccurrencesOfString:@"-" withString:@"+"]
      stringByReplacingOccurrencesOfString:@"_" withString:@"/"];
  NSInteger pad = (4 - (b64.length % 4)) % 4;
  if (pad) b64 = [b64 stringByPaddingToLength:b64.length + pad withString:@"=" startingAtIndex:0];
  return [[NSData alloc] initWithBase64EncodedString:b64 options:0];
}

static NSString *Base64UrlFromData(NSData *d) {
  NSString *b64 = [d base64EncodedStringWithOptions:0];
  b64 = [[b64 stringByReplacingOccurrencesOfString:@"+" withString:@"-"]
      stringByReplacingOccurrencesOfString:@"/" withString:@"_"];
  return [b64 stringByReplacingOccurrencesOfString:@"=" withString:@""];
}

static NSString *ErrorCodeFor(NSError *error) {
  if (![error.domain isEqualToString:ASAuthorizationErrorDomain]) return @"internal";
  switch (error.code) {
    case ASAuthorizationErrorCanceled:
      return @"cancelled";
    case ASAuthorizationErrorFailed:
    case ASAuthorizationErrorNotHandled:
    case ASAuthorizationErrorNotInteractive:
    case ASAuthorizationErrorInvalidResponse:
      return @"not-allowed";
    default:
      return @"internal";
  }
}

@interface MMPasskeyDelegate : NSObject <ASAuthorizationControllerDelegate, ASAuthorizationControllerPresentationContextProviding>
@property(nonatomic, weak) NSWindow *anchorWindow;
@property(nonatomic, copy) void (^completion)(id<ASAuthorizationCredential> credential, NSError *error);
@end

@implementation MMPasskeyDelegate
- (ASPresentationAnchor)presentationAnchorForAuthorizationController:(ASAuthorizationController *)controller {
  return self.anchorWindow;
}
- (void)authorizationController:(ASAuthorizationController *)controller
    didCompleteWithAuthorization:(ASAuthorization *)authorization {
  if (self.completion) self.completion(authorization.credential, nil);
}
- (void)authorizationController:(ASAuthorizationController *)controller didCompleteWithError:(NSError *)error {
  if (self.completion) self.completion(nil, error);
}
@end

// Apple's completion handler can fire on any queue, and even the Electron
// main/JS OS thread has no live V8 HandleScope outside a libuv tick — a raw
// dispatch_async(main queue) segfaults here. ThreadSafeFunction is what
// actually re-enters through Node's own dispatch to make Napi calls safe.
static NSMutableSet<MMPasskeyDelegate *> *PendingDelegates() {
  static NSMutableSet<MMPasskeyDelegate *> *pending = [NSMutableSet new];
  return pending;
}

static NSArray<NSDictionary *> *ArrayOrEmpty(NSDictionary *dict, NSString *key) {
  id v = dict[key];
  return [v isKindOfClass:[NSArray class]] ? v : @[];
}

static void ApplyClientData(ASPublicKeyCredentialClientData *clientData, NSDictionary *req) {
  NSString *topOrigin = req[@"topOrigin"];
  if (topOrigin) clientData.topOrigin = topOrigin;
  clientData.crossOrigin = [req[@"crossOrigin"] boolValue]
      ? ASPublicKeyCredentialClientDataCrossOriginValueCrossOrigin
      : ASPublicKeyCredentialClientDataCrossOriginValueSameOriginWithAncestors;
}

static NSArray<ASAuthorizationPlatformPublicKeyCredentialDescriptor *> *PlatformDescriptors(NSArray<NSDictionary *> *raw) {
  NSMutableArray *out = [NSMutableArray new];
  for (NSDictionary *d in raw) {
    NSData *credId = DataFromBase64Url(d[@"id"]);
    if (credId) [out addObject:[[ASAuthorizationPlatformPublicKeyCredentialDescriptor alloc] initWithCredentialID:credId]];
  }
  return out;
}

static NSArray<ASAuthorizationSecurityKeyPublicKeyCredentialDescriptor *> *SecurityKeyDescriptors(NSArray<NSDictionary *> *raw) {
  NSMutableArray *out = [NSMutableArray new];
  for (NSDictionary *d in raw) {
    NSData *credId = DataFromBase64Url(d[@"id"]);
    if (credId)
      [out addObject:[[ASAuthorizationSecurityKeyPublicKeyCredentialDescriptor alloc] initWithCredentialID:credId
                                                                                                 transports:@[
                                                                                                   ASAuthorizationSecurityKeyPublicKeyCredentialDescriptorTransportUSB,
                                                                                                   ASAuthorizationSecurityKeyPublicKeyCredentialDescriptorTransportNFC,
                                                                                                   ASAuthorizationSecurityKeyPublicKeyCredentialDescriptorTransportBluetooth
                                                                                                 ]]];
  }
  return out;
}

static NSDictionary *SerializeCredential(id<ASAuthorizationCredential> credential) {
  NSString *rawId = Base64UrlFromData([(id)credential credentialID]);
  NSMutableDictionary *response = [NSMutableDictionary new];
  NSString *clientDataJSON = Base64UrlFromData([(id)credential rawClientDataJSON]);
  response[@"clientDataJSON"] = clientDataJSON;
  if ([credential conformsToProtocol:@protocol(ASAuthorizationPublicKeyCredentialRegistration)]) {
    response[@"attestationObject"] = Base64UrlFromData([(id)credential rawAttestationObject]);
  } else {
    response[@"authenticatorData"] = Base64UrlFromData([(id)credential rawAuthenticatorData]);
    response[@"signature"] = Base64UrlFromData([(id)credential signature]);
    NSData *userHandle = [(id)credential userID];
    if (userHandle.length) response[@"userHandle"] = Base64UrlFromData(userHandle);
  }
  return @{ @"id" : rawId, @"rawId" : rawId, @"type" : @"public-key", @"response" : response };
}

struct PasskeyOutcome {
  bool ok;
  std::string payload;
};

Napi::Value AuthorizationState(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  if (@available(macOS 13.3, *)) {
    ASAuthorizationWebBrowserPublicKeyCredentialManager *manager = [ASAuthorizationWebBrowserPublicKeyCredentialManager new];
    switch (manager.authorizationStateForPlatformCredentials) {
      case ASAuthorizationWebBrowserPublicKeyCredentialManagerAuthorizationStateAuthorized:
        return Napi::String::New(env, "authorized");
      case ASAuthorizationWebBrowserPublicKeyCredentialManagerAuthorizationStateDenied:
        return Napi::String::New(env, "denied");
      default:
        return Napi::String::New(env, "not-determined");
    }
  }
  return Napi::String::New(env, "unsupported-os");
}

Napi::Value Request(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  auto deferred = Napi::Promise::Deferred::New(env);

  if (!(@available(macOS 13.5, *))) {
    deferred.Reject(Napi::String::New(env, "unsupported-os"));
    return deferred.Promise();
  }

  Napi::Buffer<uint8_t> handleBuf = info[0].As<Napi::Buffer<uint8_t>>();
  std::string json = info[1].As<Napi::String>().Utf8Value();

  NSView *view = *reinterpret_cast<NSView *__unsafe_unretained *>(handleBuf.Data());
  NSWindow *window = view.window;

  NSData *jsonData = [NSData dataWithBytes:json.data() length:json.size()];
  NSError *parseErr = nil;
  NSDictionary *req = [NSJSONSerialization JSONObjectWithData:jsonData options:0 error:&parseErr];
  if (!req) {
    deferred.Reject(Napi::String::New(env, "internal"));
    return deferred.Promise();
  }

  NSString *kind = req[@"kind"];
  NSString *rpId = req[@"rpId"];
  NSData *challenge = DataFromBase64Url(req[@"challenge"]);
  ASPublicKeyCredentialClientData *clientData =
      [[ASPublicKeyCredentialClientData alloc] initWithChallenge:challenge origin:req[@"origin"]];
  ApplyClientData(clientData, req);

  ASAuthorizationPlatformPublicKeyCredentialProvider *platformProvider =
      [[ASAuthorizationPlatformPublicKeyCredentialProvider alloc] initWithRelyingPartyIdentifier:rpId];
  ASAuthorizationSecurityKeyPublicKeyCredentialProvider *securityKeyProvider =
      [[ASAuthorizationSecurityKeyPublicKeyCredentialProvider alloc] initWithRelyingPartyIdentifier:rpId];
  NSMutableArray<ASAuthorizationRequest *> *requests = [NSMutableArray new];

  if ([kind isEqualToString:@"create"]) {
    NSData *userId = DataFromBase64Url(req[@"userId"]);
    NSString *name = req[@"userName"] ?: @"";
    NSString *displayName = req[@"userDisplayName"] ?: name;

    id<ASAuthorizationWebBrowserPlatformPublicKeyCredentialProvider> platform = (id)platformProvider;
    ASAuthorizationPlatformPublicKeyCredentialRegistrationRequest *platformRequest =
        [platform createCredentialRegistrationRequestWithClientData:clientData name:name userID:userId];
    if (req[@"userVerification"]) platformRequest.userVerificationPreference = req[@"userVerification"];
    [requests addObject:platformRequest];

    id<ASAuthorizationWebBrowserSecurityKeyPublicKeyCredentialProvider> securityKey = (id)securityKeyProvider;
    ASAuthorizationSecurityKeyPublicKeyCredentialRegistrationRequest *securityKeyRequest =
        [securityKey createCredentialRegistrationRequestWithClientData:clientData
                                                             displayName:displayName
                                                                    name:name
                                                                  userID:userId];
    NSMutableArray<ASAuthorizationPublicKeyCredentialParameters *> *params = [NSMutableArray new];
    for (NSDictionary *p in ArrayOrEmpty(req, @"pubKeyCredParams")) {
      NSNumber *alg = p[@"alg"];
      if (alg) [params addObject:[[ASAuthorizationPublicKeyCredentialParameters alloc] initWithAlgorithm:alg.integerValue]];
    }
    securityKeyRequest.credentialParameters =
        params.count ? params : @[ [[ASAuthorizationPublicKeyCredentialParameters alloc] initWithAlgorithm:ASCOSEAlgorithmIdentifierES256] ];
    [requests addObject:securityKeyRequest];
  } else {
    id<ASAuthorizationWebBrowserPlatformPublicKeyCredentialProvider> platform = (id)platformProvider;
    ASAuthorizationPlatformPublicKeyCredentialAssertionRequest *platformRequest =
        [platform createCredentialAssertionRequestWithClientData:clientData];
    platformRequest.allowedCredentials = PlatformDescriptors(ArrayOrEmpty(req, @"allowCredentials"));
    if (req[@"userVerification"]) platformRequest.userVerificationPreference = req[@"userVerification"];
    [requests addObject:platformRequest];

    id<ASAuthorizationWebBrowserSecurityKeyPublicKeyCredentialProvider> securityKey = (id)securityKeyProvider;
    ASAuthorizationSecurityKeyPublicKeyCredentialAssertionRequest *securityKeyRequest =
        [securityKey createCredentialAssertionRequestWithClientData:clientData];
    securityKeyRequest.allowedCredentials = SecurityKeyDescriptors(ArrayOrEmpty(req, @"allowCredentials"));
    [requests addObject:securityKeyRequest];
  }

  ASAuthorizationController *controller = [[ASAuthorizationController alloc] initWithAuthorizationRequests:requests];
  MMPasskeyDelegate *delegate = [MMPasskeyDelegate new];
  delegate.anchorWindow = window;
  [PendingDelegates() addObject:delegate];
  controller.delegate = delegate;
  controller.presentationContextProvider = delegate;

  Napi::Function noop = Napi::Function::New(env, [](const Napi::CallbackInfo &) {});
  Napi::ThreadSafeFunction tsfn = Napi::ThreadSafeFunction::New(env, noop, "MMPasskeyRequest", 0, 1);

  __weak MMPasskeyDelegate *weakDelegate = delegate;
  delegate.completion = ^(id<ASAuthorizationCredential> credential, NSError *error) {
    [PendingDelegates() removeObject:weakDelegate];
    auto *outcome = new PasskeyOutcome();
    if (error) {
      outcome->ok = false;
      outcome->payload = std::string([ErrorCodeFor(error) UTF8String]);
    } else {
      NSDictionary *result = SerializeCredential(credential);
      NSData *out = [NSJSONSerialization dataWithJSONObject:result options:0 error:nil];
      outcome->ok = true;
      outcome->payload.assign(static_cast<const char *>(out.bytes), out.length);
    }
    tsfn.NonBlockingCall(outcome, [deferred, tsfn](Napi::Env callEnv, Napi::Function, PasskeyOutcome *data) {
      if (data->ok) {
        deferred.Resolve(Napi::String::New(callEnv, data->payload));
      } else {
        deferred.Reject(Napi::String::New(callEnv, data->payload));
      }
      delete data;
      tsfn.Release();
    });
  };

  [controller performRequests];
  return deferred.Promise();
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("authorizationState", Napi::Function::New(env, AuthorizationState));
  exports.Set("request", Napi::Function::New(env, Request));
  return exports;
}

NODE_API_MODULE(passkeys, Init)
