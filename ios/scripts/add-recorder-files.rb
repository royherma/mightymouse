#!/usr/bin/env ruby
# Adds AudioCapture/RecordingModel/RecordingOverlay to the MightyMouse APP
# target only -- never the widget extension, which cannot touch AVAudioSession
# (background-audio-spike.md's isolation advice). Re-runnable: skips any file
# already registered so a partial run or a second invocation is a no-op.

require 'xcodeproj'

PROJECT_PATH = File.expand_path('../MightyMouse.xcodeproj', __dir__)
APP_TARGET_NAME = 'MightyMouse'

project = Xcodeproj::Project.open(PROJECT_PATH)

app_target = project.targets.find { |t| t.name == APP_TARGET_NAME }
raise "#{APP_TARGET_NAME} target not found" unless app_target

app_group = project.main_group.find_subpath('MightyMouse', false)
raise "MightyMouse group not found" unless app_group

APP_ONLY_FILES = %w[AudioCapture.swift RecordingModel.swift RecordingOverlay.swift].freeze

added = []
APP_ONLY_FILES.each do |name|
  path = File.expand_path("../MightyMouse/#{name}", __dir__)
  raise "missing #{path}" unless File.exist?(path)
  next if project.files.any? { |f| f.path == name }

  file_ref = app_group.new_reference(path)
  app_target.add_file_references([file_ref])
  added << name
end

if added.empty?
  puts 'All recorder files already registered — nothing to do.'
else
  project.save
  puts "Added to #{APP_TARGET_NAME} target: #{added.join(', ')}"
end
