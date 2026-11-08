#!/usr/bin/env ruby
# Adds the EXISTING MMLog.swift file ref to the widget target's sources phase.
# Unlike add-widget-status-file.rb this creates no new reference -- the file is
# already in the app group; it just gains a second target membership so the
# extension can log into the same subsystem the app does.

require 'xcodeproj'

PROJECT_PATH = File.expand_path('../MightyMouse.xcodeproj', __dir__)
WIDGET_TARGET_NAME = 'MightyMouseWidgets'
SHARED_FILE = 'MMLog.swift'

project = Xcodeproj::Project.open(PROJECT_PATH)
widget_target = project.targets.find { |t| t.name == WIDGET_TARGET_NAME }
raise "#{WIDGET_TARGET_NAME} target not found" unless widget_target

file_ref = project.files.find { |f| f.path == SHARED_FILE }
raise "#{SHARED_FILE} has no file reference" unless file_ref

already = widget_target.source_build_phase.files.any? { |bf| bf.file_ref == file_ref }
if already
  puts "#{SHARED_FILE} already in #{WIDGET_TARGET_NAME} — nothing to do."
else
  widget_target.add_file_references([file_ref])
  project.save
  puts "Added #{SHARED_FILE} to #{WIDGET_TARGET_NAME} target."
end
