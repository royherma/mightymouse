#!/usr/bin/env ruby
# Adds HostStatusWidget.swift to the already-existing MightyMouseWidgets
# target/group. add-widget-target.rb creates the target and exits early once
# it exists, so a NEW file needs this file-only script instead -- same shape
# as add-recorder-files.rb for the app target.
#
# PRD: prds/active/2026-08-02-1785661910-ios-widgets-hold-to-note.md §5 step 4.

require 'xcodeproj'

PROJECT_PATH = File.expand_path('../MightyMouse.xcodeproj', __dir__)
WIDGET_TARGET_NAME = 'MightyMouseWidgets'
NEW_FILE = 'HostStatusWidget.swift'

project = Xcodeproj::Project.open(PROJECT_PATH)
widget_target = project.targets.find { |t| t.name == WIDGET_TARGET_NAME }
raise "#{WIDGET_TARGET_NAME} target not found — run add-widget-target.rb first" unless widget_target
widget_group = project.main_group.find_subpath(WIDGET_TARGET_NAME, false)
raise "#{WIDGET_TARGET_NAME} group not found" unless widget_group

path = File.expand_path("../MightyMouseWidgets/#{NEW_FILE}", __dir__)
raise "missing #{path}" unless File.exist?(path)

if project.files.any? { |f| f.path == NEW_FILE }
  puts "#{NEW_FILE} already registered — nothing to do."
else
  file_ref = widget_group.new_reference(path)
  widget_target.add_file_references([file_ref])
  project.save
  puts "Added #{NEW_FILE} to #{WIDGET_TARGET_NAME} target."
end
