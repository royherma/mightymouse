#!/usr/bin/env ruby
# Adds the MightyMouseWidgets app-extension target to MightyMouse.xcodeproj.
# Re-runnable: exits early if the target already exists so it's safe to
# re-invoke after a partial run or a project reset.
#
# PRD: prds/active/2026-08-02-1785661910-ios-widgets-hold-to-note.md §5 step 1.
# Why a script and not a hand-authored pbxproj diff: ios/Config.xcconfig
# documents this file breaking on a bare PBXGroup edit -- the xcodeproj gem
# (verified 2026-08-03, gem 1.27.0) is the only route that has round-tripped
# this project without corrupting it.

require 'xcodeproj'

PROJECT_PATH = File.expand_path('../MightyMouse.xcodeproj', __dir__)
WIDGET_TARGET_NAME = 'MightyMouseWidgets'
DEV_TEAM = 'BZJ35GS989'
APP_GROUP_ID = 'group.com.mightymouse.ios'

project = Xcodeproj::Project.open(PROJECT_PATH)

if project.targets.any? { |t| t.name == WIDGET_TARGET_NAME }
  puts "#{WIDGET_TARGET_NAME} already exists — nothing to do."
  exit 0
end

app_target = project.targets.find { |t| t.name == 'MightyMouse' }
raise "MightyMouse app target not found" unless app_target

app_group = project.main_group.find_subpath('MightyMouse', false)
raise "MightyMouse group not found" unless app_group

shared_app_group_path = File.expand_path('../MightyMouse/SharedAppGroup.swift', __dir__)
raise "missing #{shared_app_group_path}" unless File.exist?(shared_app_group_path)
unless project.files.any? { |f| f.path == 'SharedAppGroup.swift' }
  shared_ref = app_group.new_reference(shared_app_group_path)
  app_target.add_file_references([shared_ref])
end

widget_group = project.main_group.new_group('MightyMouseWidgets', 'MightyMouseWidgets')

widget_dir = File.expand_path('../MightyMouseWidgets', __dir__)
WIDGET_SOURCE_FILES = %w[
  MightyMouseWidgetsBundle.swift
  ControlWidgets.swift
].freeze

widget_target = project.new_target(
  :app_extension,
  WIDGET_TARGET_NAME,
  :ios,
  nil,
  project.products_group,
  :swift
)

WIDGET_SOURCE_FILES.each do |name|
  path = File.join(widget_dir, name)
  raise "missing #{path} — create it before running this script" unless File.exist?(path)
  file_ref = widget_group.new_reference(path)
  widget_target.add_file_references([file_ref])
end

info_plist_ref = widget_group.new_reference(File.join(widget_dir, 'Info.plist'))
entitlements_ref = widget_group.new_reference(File.join(widget_dir, 'MightyMouseWidgets.entitlements'))

# Dual-target files: both live under the app's group already, so we reuse
# their existing PBXFileReference rather than adding a second one for the
# same path (a duplicate ref is what the gem's own docs warn corrupts Xcode's
# file inspector). AskMightyIntent's fallback needs NativeIntentRouter too, so
# Intents.swift comes along even though only OnDeviceModel is dependency-free
# on its own -- NativeIntentRouter.isConnected is `bridge != nil`, and `bridge`
# is never set outside `RemoteWebView.makeUIView` (app-only), so it compiles
# to a constant false in the extension without any extension-specific code.
DUAL_TARGET_FILES = %w[SharedAppGroup.swift Intents.swift OnDeviceModel.swift].freeze
DUAL_TARGET_FILES.each do |name|
  existing_ref = project.files.find { |f| f.path == name }
  raise "#{name} not found in project — expected it under the MightyMouse group" unless existing_ref
  widget_target.add_file_references([existing_ref])
end

widget_target.build_configurations.each do |config|
  is_debug = config.name == 'Debug'
  bundle_id = is_debug ? 'com.mightymouse.ios.dev.widgets' : 'com.mightymouse.ios.widgets'

  config.build_settings.merge!(
    'SDKROOT' => 'iphoneos',
    'SUPPORTED_PLATFORMS' => 'iphoneos iphonesimulator',
    'TARGETED_DEVICE_FAMILY' => '1',
    'IPHONEOS_DEPLOYMENT_TARGET' => '18.0',
    'DEVELOPMENT_TEAM' => DEV_TEAM,
    'CODE_SIGN_STYLE' => 'Automatic',
    'CODE_SIGNING_ALLOWED[sdk=iphonesimulator*]' => 'NO',
    'CODE_SIGNING_REQUIRED[sdk=iphonesimulator*]' => 'NO',
    'PRODUCT_BUNDLE_IDENTIFIER' => bundle_id,
    'PRODUCT_NAME' => '$(TARGET_NAME)',
    'INFOPLIST_FILE' => 'MightyMouseWidgets/Info.plist',
    'CODE_SIGN_ENTITLEMENTS' => 'MightyMouseWidgets/MightyMouseWidgets.entitlements',
    'SWIFT_VERSION' => '5.0',
    'SKIP_INSTALL' => 'YES',
    'GENERATE_INFOPLIST_FILE' => 'NO',
    'MARKETING_VERSION' => '1.0',
    'CURRENT_PROJECT_VERSION' => '1',
    'CLANG_ENABLE_MODULES' => 'YES',
    'ALWAYS_SEARCH_USER_PATHS' => 'NO',
    # Intents.swift is dual-target; this flag is how it picks the
    # WebKit-free NativeIntentRouter stub instead of pulling in NativeBridge,
    # which the extension can never construct (no WKWebView host).
    'SWIFT_ACTIVE_COMPILATION_CONDITIONS' => 'MM_WIDGET_EXTENSION $(inherited)'
  )
end

app_target.add_dependency(widget_target)

embed_phase = app_target.copy_files_build_phases.find { |p| p.symbol_dst_subfolder_spec == :plug_ins }
embed_phase ||= app_target.new_copy_files_build_phase('Embed Foundation Extensions')
embed_phase.symbol_dst_subfolder_spec = :plug_ins
embed_phase.name = 'Embed Foundation Extensions'

product_ref = widget_target.product_reference
embed_build_file = embed_phase.add_file_reference(product_ref, true)
embed_build_file.settings = { 'ATTRIBUTES' => ['RemoveHeadersOnCopy'] }

project.save

puts "Added #{WIDGET_TARGET_NAME} (app-extension), bundle ids com.mightymouse.ios.widgets / com.mightymouse.ios.dev.widgets."
puts "Run: xcodebuild -project #{PROJECT_PATH} -list"
