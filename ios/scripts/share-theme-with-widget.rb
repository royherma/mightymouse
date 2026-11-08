#!/usr/bin/env ruby
# Gives the EXISTING Generated/Theme.swift a second target membership so widget
# views can use the same MMColor/MMFont tokens the app does. Same shape as
# share-mmlog-with-widget.rb -- no new file reference is created.

require 'xcodeproj'

PROJECT_PATH = File.expand_path('../MightyMouse.xcodeproj', __dir__)
WIDGET_TARGET_NAME = 'MightyMouseWidgets'
SHARED_FILE = 'Theme.swift'

project = Xcodeproj::Project.open(PROJECT_PATH)
widget_target = project.targets.find { |t| t.name == WIDGET_TARGET_NAME }
raise "#{WIDGET_TARGET_NAME} target not found" unless widget_target

file_ref = project.files.find { |f| f.path&.end_with?(SHARED_FILE) }
raise "#{SHARED_FILE} has no file reference" unless file_ref

already = widget_target.source_build_phase.files.any? { |bf| bf.file_ref == file_ref }
if already
  puts "#{SHARED_FILE} already in #{WIDGET_TARGET_NAME} — nothing to do."
else
  widget_target.add_file_references([file_ref])
  project.save
  puts "Added #{SHARED_FILE} to #{WIDGET_TARGET_NAME} target."
end
