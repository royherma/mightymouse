#!/usr/bin/env ruby
# Drops RecordingOverlay.swift from the app target. The native recording bar
# was a second recorder alongside the deck's own mic; the Record control now
# emits `startRecording` to the page instead, so the file is gone.
#
#   ruby ios/scripts/remove-recording-overlay.rb
#
# project.pbxproj is hand-rolled here -- never hand-edit it, always go through
# this gem so the file/build refs stay consistent.
require 'xcodeproj'

project_path = File.expand_path('../MightyMouse.xcodeproj', __dir__)
project = Xcodeproj::Project.open(project_path)

TARGET_FILE = 'RecordingOverlay.swift'

removed = 0
project.files.select { |f| f.path&.end_with?(TARGET_FILE) }.each do |file_ref|
  project.targets.each do |target|
    target.source_build_phase.files.select { |bf| bf.file_ref == file_ref }.each do |build_file|
      target.source_build_phase.remove_build_file(build_file)
      removed += 1
    end
  end
  file_ref.remove_from_project
end

project.save
puts "removed #{TARGET_FILE}: #{removed} build-file entr#{removed == 1 ? 'y' : 'ies'}"
