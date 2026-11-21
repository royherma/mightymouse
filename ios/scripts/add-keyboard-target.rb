#!/usr/bin/env ruby
# Adds the MightyMouseKeyboard extension and its shared files. Safe to re-run.
require 'xcodeproj'

PROJECT_PATH = File.expand_path('../MightyMouse.xcodeproj', __dir__)
NAME = 'MightyMouseKeyboard'
project = Xcodeproj::Project.open(PROJECT_PATH)

if project.targets.any? { |t| t.name == NAME }
  puts "#{NAME} already exists - nothing to do."
  exit 0
end

app_target = project.targets.find { |t| t.name == 'MightyMouse' } or raise 'app target missing'
app_group = project.main_group.find_subpath('MightyMouse', false) or raise 'app group missing'

%w[VoiceTyping.swift KeyboardCompanion.swift].each do |name|
  next if project.files.any? { |f| f.path == name }
  path = File.expand_path("../MightyMouse/#{name}", __dir__)
  raise "missing #{path}" unless File.exist?(path)
  app_target.add_file_references([app_group.new_reference(path)])
end

dir = File.expand_path("../#{NAME}", __dir__)
group = project.main_group.new_group(NAME, NAME)
target = project.new_target(:app_extension, NAME, :ios, nil, project.products_group, :swift)
target.add_file_references([group.new_reference(File.join(dir, 'KeyboardViewController.swift'))])
group.new_reference(File.join(dir, 'Info.plist'))
group.new_reference(File.join(dir, "#{NAME}.entitlements"))

%w[SharedAppGroup.swift VoiceTyping.swift Generated/Theme.swift].each do |name|
  ref = project.files.find { |f| f.path == name } or raise "#{name} not in project"
  target.add_file_references([ref])
end

target.build_configurations.each do |config|
  debug = config.name == 'Debug'
  config.build_settings.merge!(
    'ALWAYS_SEARCH_USER_PATHS' => 'NO',
    'APPLICATION_EXTENSION_API_ONLY' => 'YES',
    'CODE_SIGNING_ALLOWED[sdk=iphonesimulator*]' => 'NO',
    'CODE_SIGNING_REQUIRED[sdk=iphonesimulator*]' => 'NO',
    'CODE_SIGN_ENTITLEMENTS' => "#{NAME}/#{NAME}.entitlements",
    'CODE_SIGN_IDENTITY' => debug ? 'Apple Development' : 'Apple Distribution',
    'CODE_SIGN_IDENTITY[sdk=iphonesimulator*]' => '',
    'CODE_SIGN_STYLE' => debug ? 'Automatic' : 'Manual',
    'CURRENT_PROJECT_VERSION' => '22',
    'DEVELOPMENT_TEAM' => 'BZJ35GS989',
    'GENERATE_INFOPLIST_FILE' => 'NO',
    'INFOPLIST_FILE' => "#{NAME}/Info.plist",
    'IPHONEOS_DEPLOYMENT_TARGET' => '18.0',
    'LD_RUNPATH_SEARCH_PATHS' => ['$(inherited)', '@executable_path/Frameworks', '@executable_path/../../Frameworks'],
    'MARKETING_VERSION' => '1.0.10',
    'PRODUCT_BUNDLE_IDENTIFIER' => debug ? 'com.mightymouse.ios.dev.keyboard' : 'com.mightymouse.ios.keyboard',
    'PRODUCT_NAME' => '$(TARGET_NAME)',
    'SDKROOT' => 'iphoneos',
    'SKIP_INSTALL' => 'YES',
    'SUPPORTED_PLATFORMS' => 'iphoneos iphonesimulator',
    'SWIFT_EMIT_LOC_STRINGS' => 'YES',
    'SWIFT_VERSION' => '5.0',
    'TARGETED_DEVICE_FAMILY' => '1'
  )
  config.build_settings['PROVISIONING_PROFILE_SPECIFIER'] = 'MM Keyboard App Store' unless debug
end

app_target.add_dependency(target)
embed = app_target.copy_files_build_phases.find { |p| p.symbol_dst_subfolder_spec == :plug_ins } or raise 'embed phase missing'
embed.add_file_reference(target.product_reference, true).settings = { 'ATTRIBUTES' => ['RemoveHeadersOnCopy'] }

project.save
puts "Added #{NAME}."
