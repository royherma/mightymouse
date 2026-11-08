{
  "targets": [
    {
      "target_name": "passkeys",
      "sources": ["passkeys.mm"],
      "include_dirs": ["<!@(node -p \"require('node-addon-api').include\")"],
      "dependencies": ["<!(node -p \"require('node-addon-api').gyp\")"],
      "defines": ["NAPI_DISABLE_CPP_EXCEPTIONS"],
      "xcode_settings": {
        "OTHER_CFLAGS": ["-ObjC++", "-fobjc-arc"],
        "MACOSX_DEPLOYMENT_TARGET": "13.5"
      },
      "link_settings": {
        "libraries": [
          "-framework AuthenticationServices",
          "-framework AppKit",
          "-framework Foundation",
          "-framework LocalAuthentication"
        ]
      }
    }
  ]
}
