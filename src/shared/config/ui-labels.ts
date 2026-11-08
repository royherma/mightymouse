// Every user-facing string rendered by the desktop windows, in one place so a
// copy change never means hunting through components. Split out of config.ts
// (386 lines). Takes appName so the module does no branding resolution itself.

export const buildUiLabels = (appName: string) => ({
  SESSION_PRIORITY: {
  button: 'Prioritize',
  checking: 'Reading each agent’s latest update…',
  intro: 'Puts the agents waiting on you at the top.',
  how: 'How it ranks',
  rules: [
    'Asked you a question: Reply now.',
    'Everything else: AI reads the agent’s latest update and picks what to do next. Ties go to whoever waited longest.',
    'No update to read, or asleep: Not ranked, placed last.'
  ],
  rankedAt: 'Ranked',
  byStatus: 'Back to status columns',
  refresh: 'Update ranking',
  sort: 'Needs attention first',
  unknown: 'Not ranked',
  missing: 'No recent update to rank',
  stale: 'No recent check-in',
  identity: 'Session identity unavailable',
  changed: 'Update changed. Rank again.',
  failed: 'Ranking unavailable. Local status is still shown.',
  partial: 'Some agents could not be ranked.',
  cap: 'Not ranked this time',
  human: 'Waiting for your answer',
  management: 'Shared work settings',
  unassigned: '{n} sessions closed with work still open.',
  checkThem: 'Check them',
  openWork: 'Open shared work',
  workStates: { working: 'In progress', blocked: 'Blocked', pending: 'Waiting for a reply' },
  next: 'Next action',
  reading: 'Reading the latest update…',
  noReply: 'No clear quick reply. Open the conversation to review.',
  go: 'Go',
  send: 'Send “Go”',
  edit: 'Edit reply',
  sent: 'Reply sent',
  sending: 'Sending…',
  sendFailed: 'Reply not confirmed. Check the conversation before trying again.',
  waiting: 'Waiting for your go-ahead',
  open: 'Open conversation',
  close: 'Close',
  evidence: 'This reply continues the request below:',
  archive: 'Archive',
  tidy: 'Looks done',
  tidyAll: 'Archive these {n}',
  tidyDone: 'Archived {n}',
  tidyUndo: 'Undo',
  tidyEnded: 'Ended',
  tidyFinished: 'Finished',
  rankOf: '#{rank} of {of}',
  heatStale: 'New update since ranking',
  old: 'Out of date, update to re-rank',
  scale: '#1 needs you most',
  labels: ['Finished', 'Idle', 'Working on its own', 'Wants a reply soon', 'Blocked on you']
} as const,
  // Conversation search (⌘F). Says "search", not "filter": it looks inside
  // messages now, not just titles, and people search a chat for what was said.
  SEARCH_CONVERSATIONS: 'Search chats and messages',
  SIDEBAR_NEW_CHAT: 'New chat',
  SIDEBAR_PINNED: 'Pinned',
  SIDEBAR_PROJECTS: 'Projects',
  SIDEBAR_CHATS: 'Chats',
  SIDEBAR_MODE_ALL: 'Everything',
  SETTINGS_OPEN_PROJECTS: 'Open your projects',
  LIBRARY_VIEW_MEDIA: 'Pictures and videos',
  LIBRARY_VIEW_MADE: 'Built for you',
  SIDEBAR_AGENTS: 'Agents',
  ROUTE_TO_CHAT: 'Answer in chat',
  ROUTE_TO_AGENT: 'Start an agent in',
  ROUTE_FLIP_HINT: 'Click to switch',
  SEARCH_CONVERSATIONS_PLACEHOLDER: 'Search your chats…',
  SIDEBAR_FILTER: 'Choose what shows in this list',
  SIDEBAR_FILTER_HEAD: 'Show',
  // "Nothing was sent" beats "empty": a voice note you never followed up on still
  // FEELS like something, so name what didn't happen, not what the row lacks.
  SIDEBAR_SHOW_EMPTY: 'Ones you never sent anything in',
  SIDEBAR_SHOW_ARCHIVED: 'Archived chats',
  SIDEBAR_NO_MATCHES: 'Nothing to show. Change what shows above.',
  SIDEBAR_SHOW_MORE: 'Show more',
  SIDEBAR_MORE: 'More',
  BUBBA: 'Bubba',
  SIDEBAR_SETUP: 'Setup',
  SIDEBAR_OPEN: 'open',
  SIDEBAR_SHOW_LESS: 'Show less',
  SIDEBAR_COLLAPSE: 'Collapse',
  SIDEBAR_EXPAND: 'Expand',
  // A chat with no title yet. One noun across the whole surface: the button says
  // "New chat", so the row it creates must not say "New conversation".
  UNTITLED_CHAT: 'New chat',
  CHAT_PANE_EMPTY_HEADLINE: 'What would you like to do?',
  CHAT_PANE_EMPTY_BODY: 'Write, make images and video, or build something - with every top AI.',
  CHAT_OPEN_SIX: 'Run 6 chats side by side',
  CODE_AGENT_PANE_NAME: 'Agent',
  CODE_AGENT_PANE_GONE: 'This agent has closed.',
  CODE_AGENT_PANE_NEW: 'Start a new agent here',
  CHAT_PROJECT_SCOPE_TITLE: 'Choose where this chat is saved',
  CHAT_PROJECT_SETTINGS: 'Project settings…',
  CHAT_PROJECT_SAVES_UNDER: 'Saves under {name}',
  CHAT_PROJECT_SAVES_UNASSIGNED: 'Saves as Unassigned',
  CODE_AGENT_PROJECT_LABEL: 'Project',
  CODE_AGENTS_EMPTY_PICK: 'Pick an agent on the left to see what it is doing.',
  CODE_AGENTS_EMPTY_HOME: 'Choose a project above, or pick an agent from the list.',
  CODE_AGENTS_EMPTY_FIRST: 'Pick the folder your code lives in and your first agent starts working there.',
  CODE_START_PICK_FOLDER: 'Pick a project folder',
  CODE_START_FIRST_AGENT: 'Start your first agent',
  CODE_AGENTS_EMPTY_IN_PROJECT: 'No agents in {name} yet. Use + beside that project to start one here.',
  CODE_AGENTS_START_HINT: 'Starts in {folder}',
  CODE_AGENTS_START_IN_APP: 'Start a new agent here',
  CODE_AGENTS_DRAFT_TITLE: 'New agent in {name}',
  CODE_AGENTS_DRAFT_HEADLINE: 'What should we build in {name}?',
  CODE_AGENTS_DRAFT_HEADLINE_NO_PROJECT: 'What should we build?',
  CODE_AGENTS_DRAFT_PLACEHOLDER: 'Tell it what to do first…',
  CODE_BRANCH_TITLE: 'Which branch this agent works on',
  CODE_BRANCH_SAME: 'Work on {branch}',
  CODE_BRANCH_SAME_DETAIL: 'Edits land in your project folder, alongside any other agents there.',
  CODE_BRANCH_NEW: 'New branch from {branch}',
  CODE_BRANCH_NEW_SHORT: 'New branch',
  CODE_BRANCH_FROM: 'from {branch}',
  CODE_BRANCH_NEW_DETAIL: 'Its own copy of the project, so no other agent can touch its files.',
  CODE_BRANCH_NEW_DIRTY: 'Its own copy, starting from your last commit. Your {n} uncommitted change{s} stay on {branch}.',
  CODE_ATTACHED_PLACEHOLDER: 'Add a note, or just send it.',
  CODE_AGENTS_DRAFT_STARTING: 'Starting…',
  CODE_AGENTS_REOPENING: 'Opening your last session…',
  CODE_IDEAS_TITLE: 'Ideas from your recent work',
  CODE_IDEAS_LOADING: 'Looking through {name}…',
  CODE_IDEAS_REFRESH: 'New ideas',
  CODE_IDEAS_EMPTY: 'No ideas yet. Try again in a moment.',
  CODE_IDEAS_KIND_FINISH: 'Finish',
  CODE_IDEAS_KIND_NEXT: 'Next',
  CODE_IDEAS_KIND_FIX: 'Fix',
  CODE_IDEAS_KIND_TRY: 'Try',
  CODE_IDEAS_MARK_DONE: 'Fixed already!',
  CODE_IDEAS_MARK_DONE_HINT: "We'll double-check the code and bring it back if it isn't.",
  CODE_IDEAS_MARK_BAD: 'Downvote',
  CODE_IDEAS_MARK_BAD_HINT: "Hides it, and you'll see fewer ideas like it.",
  CODE_IDEAS_CHECKING_DONE: "Checking the code to confirm it's done…",
  CODE_IDEAS_MARKED_DONE: "Confirmed done. We won't suggest it again.",
  CODE_IDEAS_MARKED_BAD: "Got it. We'll suggest less like this.",
  CODE_DRAFT_AGENTS: 'Agents',
  CODE_DRAFT_AGENTS_FEWER: 'Fewer agents',
  CODE_DRAFT_AGENTS_MORE: 'More agents',
  CODE_DRAFT_AGENTS_OPEN: 'Open them side by side, one tab',
  CODE_DRAFT_AGENTS_COUNT: '{n} agents',
  CODE_DRAFT_THINKING: 'Thinking',
  CODE_DRAFT_THINKING_NOTE: 'Higher takes longer and uses more of your plan.',
  CODE_DRAFT_PLAN: 'Plan',
  CODE_DRAFT_PLAN_FIRST: 'Plan first, change nothing until you say go',
  MODEL_PICK_CLI_DEFAULT: 'Your CLI setting',
  MODEL_PICK_NO_THINKING: '{name} has no thinking setting.',
  MODEL_PICK_ACCOUNT_TITLE: 'Account the new agent uses',
  MODEL_PICK_ACCOUNT_USED_UP: 'Used up for now',
  MODEL_PICK_ACCOUNT_ADD: 'Add another account',
  MODEL_PICK_ACCOUNT_SIGNING_IN: 'Finish signing in in your browser.',
  MODEL_PICK_ACCOUNT_CANCEL: 'Cancel',
  MODEL_PICK_PLAN_GROUP: 'Your {name} plan',
  MODEL_PICK_AUTO_SUB: 'Picks the best model for each message',
  MODEL_PICK_THINK_NOTE: 'This model can think before it answers. Turn it off for quick replies.',
  CODE_DRAFT_SETTINGS_TITLE: 'Model, thinking and agents',
  CODE_DRAFT_APPS_WORKS_WITH: 'Works with {names}',
  CODE_DRAFT_APPS_AND_MORE: ' and {n} more',
  CODE_DRAFT_APPS_MANAGE: 'Manage apps',
  CODE_DRAFT_RESUME_TITLE: 'Pick up where you left off',
  CODE_DRAFT_RESUME_CONTINUE: 'Continue',
  CODE_IDEAS_NOT_DONE: 'Not done yet: {reason}',
  CODE_IDEAS_UNDO: 'Undo',
  CODE_AGENTS_DRAFT_FAILED: "That didn't start. Check Claude or Codex is installed.",
  CHAT_SIDEBAR_EMPTY_HINT: 'Your conversations are here. Click one to open it.',
  CHAT_RUN_TIMEOUT: 'This took too long and stopped. Try again.',
  CHAT_REGENERATE: 'Regenerate',
  CHAT_REGENERATE_FAILED: "That didn't work. Try again.",
  CHAT_EDIT: 'Edit',
  CHAT_EDIT_SAVE: 'Save & resend',
  CHAT_EDIT_CANCEL: 'Cancel',
  CHAT_STOP: 'Stop',
  CHAT_STOPPED: 'You stopped it',
  CHAT_STEER: 'Send now - stops the current answer and starts on this',
  CHAT_EXPORT_MARKDOWN: 'Export as Markdown',
  CHAT_EXPORT_JSON: 'Export as JSON',
  CHAT_EXPORT_DONE: 'Saved',
  CHAT_EXPORT_FAILED: "That didn't save. Try again.",
  // Code tab, both empty states. Says what the person GETS -- their coding
  // agent can reach them here -- and the sample card below shows the shape of
  // it, so an empty tab still explains itself.
  // Shown only until the first status reply lands (`useAgentRelay.known`) --
  // distinct copy from CODE_EMPTY_HEADLINE so a slow-starting relay never
  // reads as "checked, and there's nothing."
  CODE_LOADING: 'Checking for agents…',
  CODE_EMPTY_HEADLINE: "You're all caught up",
  CODE_EMPTY_BODY: 'When an agent needs a yes, a no or an answer, it waits here. Answer and it keeps going.',
  CODE_EMPTY_PHONE_NOTE: 'Questions reach your phone too',
  CODE_EMPTY_SAMPLE_NOTE: 'Example of what shows up',
  CODE_PREVIOUS_EMPTY_HEADLINE: 'Nothing answered yet.',
  CODE_PREVIOUS_EMPTY_BODY: 'Questions you answer here or on your phone stay listed for a while.',
  // A blank Previous tab with the link down is not an empty history -- it is
  // an unreadable one, and saying "nothing answered yet" there would be a lie.
  CODE_PREVIOUS_OFFLINE_HEADLINE: 'Cannot reach your Mac.',
  CODE_PREVIOUS_OFFLINE_BODY: 'Check MightyMouse is open on your Mac, then pull down to reload.',
  CODE_SESSIONS_EMPTY_HEADLINE: 'No coding agents open.',
  CODE_SESSIONS_EMPTY_BODY: 'Start one and it shows up here, with what it is working on.',
  // Names what you can type, because the useful terms here are not obvious --
  // a branch or a pid is not what anyone expects a search box to take.
  CODE_SESSIONS_SEARCH: 'Search name, folder or branch',
  CODE_SESSIONS_FILTER_ALL: 'All',
  CODE_SESSIONS_SEG_WAITING: 'Waiting on you',
  CODE_SESSIONS_SEG_HANDED_BACK: 'Handed back',
  CODE_SESSIONS_SEG_WORKING: 'Working',
  CODE_SESSIONS_SEG_ALL: 'Everything',
  CODE_SESSIONS_COL_SESSION: 'Session',
  CODE_SESSIONS_COL_PROJECT: 'Project',
  CODE_SESSIONS_COL_MODEL: 'Model',
  CODE_SESSIONS_COL_STATE: 'State',
  CODE_SESSIONS_COL_PULSE: 'Pulse',
  CODE_SESSIONS_COL_ACTIVITY: 'Last activity',
  CODE_SESSIONS_FOLDER_FILTER: 'Filter',
  CODE_SESSIONS_FOLDER_ALL: 'Every folder',
  // Named rather than left blank: a session whose shim reported no checkout
  // still has to be pickable, or filtering hides it with no way back.
  CODE_SESSIONS_FOLDER_NONE: 'No folder',
  CODE_AGENTS_NO_PROJECT: 'Unassigned',
  CODE_NO_PROJECT: 'No project',
  CODE_NO_PROJECT_HINT: 'Just ask, without a folder',
  CODE_START_NO_PROJECT: 'Start without a project',
  CODE_AGENTS_ONLY_ALERTS: 'Needs you',
  CODE_AGENTS_NO_ALERTS: 'No agent is waiting on you right now.',
  CODE_AGENTS_ONLY_RUNNING: 'Running now',
  CODE_AGENTS_NO_RUNNING: 'No agent is running right now.',
  CODE_AGENTS_NO_ALERTS_OR_RUNNING: 'No agent is running or waiting on you right now.',
  CODE_AGENTS_SIDEBAR_TITLE: 'Projects',
  CODE_AGENTS_SEARCH: 'Search agents',
  CODE_AGENTS_NEW_CHAT: 'New chat',
  CODE_SIDEBAR_NEW_SESSION: 'New session',
  CODE_AGENTS_SEARCH_PLACEHOLDER: 'Search agents…',
  CODE_AGENTS_NO_MATCH: 'No agent matches what you typed.',
  // Says WHY they are hidden, so the count never reads as agents gone missing.
  CODE_AGENTS_QUIET_ONE: 'agent with nothing to show',
  CODE_AGENTS_QUIET_MANY: 'agents with nothing to show',
  CODE_CONDUCTOR_TITLE: 'From Conductor',
  CODE_CONDUCTOR_CONTINUE: 'Continue here',
  CODE_CONDUCTOR_STARTING: 'Starting...',
  CODE_CONDUCTOR_RETRY: 'Try again',
  CODE_CONDUCTOR_STARTED: 'Started - find it in your list',
  CODE_CONDUCTOR_DETAIL: 'Keep working on them here',
  NOTICE_DISMISS: 'Hide this',
  NOTICE_SHOW_BODY: 'Show',
  NOTICE_HIDE_BODY: 'Hide',
  NOTICE_SHOW_FEWER: 'Show fewer',
  NOTICE_MORE_ONE: 'more notice',
  NOTICE_MORE_MANY: 'more notices',
  CODE_AGENTS_FINISHED: 'finished',
  CODE_AGENTS_HIDE_FINISHED: 'Hide finished',
  CODE_AGENTS_HIDE_QUIET: 'Hide the quiet ones again',
  CODE_AGENTS_TABLE_FILTER: 'Filter agents…',
  CODE_AGENTS_TABLE_NO_MATCH: 'No agent matches this filter.',
  CODE_AGENTS_TABLE_COL_SESSION: 'Session',
  CODE_AGENTS_TABLE_COL_STATUS: 'Status',
  CODE_AGENTS_TABLE_COL_AGENT: 'Agent',
  CODE_AGENTS_TABLE_COL_BRANCH: 'Branch',
  CODE_AGENTS_TABLE_COL_STARTED: 'Started',
  CODE_AGENTS_TABLE_COL_ACTIVE: 'Last active',
  CODE_AGENTS_TABLE_ALL: 'All',
  CODE_AGENTS_TABLE_RESPONDING: 'Responding',
  CODE_AGENTS_TABLE_IDLE: 'Idle',
  CODE_AGENTS_TABLE_COL_PROJECT: 'Project',
  CODE_AGENTS_TABLE_COL_PRIORITY: 'Priority',
  CODE_AGENTS_TABLE_ALL_TITLE: 'All sessions',
  CODE_AGENTS_BACK_TO: 'Back to {name}',
  CODE_AGENTS_BACK_HOME: 'New session',
  CODE_AGENTS_TABLE_OPEN_ALL: 'See all sessions in a table',
  CODE_PROJECT_HOME: 'Project home',
  CODE_PROJECT_HOME_PLACEHOLDER: 'Ask or hand off anything in {name} - it goes to the right session, or starts a new one',
  CODE_PROJECT_HOME_ROUTING: 'Finding the right session…',
  CODE_PROJECT_HOME_SEND: 'Send',
  CODE_PROJECT_HOME_FAILED: 'Did not send - try again',
  CODE_AGENTS_TABLE_GROUP: 'Group by project',
  // Said in full because an empty filtered list must not read as "no agents".
  CODE_SESSIONS_FILTER_NONE: 'No agent has handed back to you yet.',
  // A session that told us nothing about itself still gets a row -- a blank
  // line reads as a bug, and it IS connected either way.
  CODE_SESSION_UNNAMED: 'Unnamed session',
  CODE_SESSION_REPLY_PLACEHOLDER: 'Tell it what to do next.',
  CODE_SESSION_RECAP: 'Recap',
  CODE_SESSION_RECAP_HIDE: 'Minimize recap',
  CODE_SESSION_RECAP_SHOW: 'Show recap',
  CODE_SESSION_TALK_TITLE: 'Press fn to talk - your voice becomes text right here on this Mac, free.',
  CODE_SESSION_TALK_ARIA: 'Talk instead of typing',
  TALK_LABEL: 'Talk',
  TALK_KEY: 'fn',
  TALK_STOP: 'Stop - your words go into the box',
  TALK_SEND: 'Stop and send what you said',
  PHONE_CLIP_NO_SOUND: "Your phone's mic didn't pick up any sound. Try again",
  TALK_TRANSCRIBING: 'Writing…',
  CODE_SESSION_SEND: 'Send',
  CODE_SESSION_ENDED: 'This agent has finished.',
  CODE_SESSION_NO_PANE: 'This agent has no window to type into.',
  CODE_SESSION_LAST_EMPTY: 'It has not sent you anything yet.',
  CODE_SESSION_FRESH_TITLE: 'Fresh session - what should it work on?',
  CODE_SESSION_NOT_YET: 'Not yet',
  // The three waits between sending and an answer. Each says which one it is,
  // because the one thing worse than waiting is not knowing what for.
  CODE_SESSION_STARTING: 'Starting it up…',
  CODE_SESSION_REPLY_AFTER_START: 'You can add more once it has started',
  CODE_SESSION_READING: 'Reading your message…',
  CODE_SESSION_THINKING: 'Working on it…',
  CODE_SESSION_COMPACTING: 'Compacting the conversation…',
  CODE_SESSION_COMPACTING_SHORT: 'Compacting…',
  // Step nav on a multi-question ask. "Back"/"Next", never "Previous"/
  // "Forward" -- shorter reads faster on a 40px control, and these two sit
  // beside each other where the pair has to be told apart at a glance.
  CODE_ASK_BACK: 'Back',
  CODE_ASK_NEXT: 'Next',
  // Says what the person GETS. The old copy claimed the answers were already
  // on their way, which was true only when the last answer settled it -- a
  // changed answer leaves them here with nothing sent.
  CODE_ASK_ALL_ANSWERED: 'That is everything. Send it when you are ready.',
  CODE_ASK_SEND_ALL: 'Send my answers',
  // Renders under a stepped-back question, so it is read WITH the chip that
  // is ticked -- it names what tapping another one does.
  CODE_ASK_CHANGE_HINT: 'Pick another one to change it.',
  CODE_SESSION_REFRESH: 'Refresh',
  CODE_SESSION_PEEK_UNCHANGED: 'No new output',
  CODE_SESSION_PEEK_UNAVAILABLE: "Couldn't read this agent",
  // "Wrap up", never "kill": the agent gets to finish and say where it got to,
  // which is the whole reason this is safe to press.
  CODE_SESSION_WRAP: 'Wrap up',
  CODE_SESSION_WRAP_BUSY: 'Wrapping up…',
  CODE_SESSION_WRAP_CONFIRM_TITLE: 'Let this agent finish?',
  CODE_SESSION_WRAP_CONFIRM_BODY:
    'It gets a moment to save what it was doing, then closes on its own.',
  CODE_SESSION_WRAP_CONFIRM_YES: 'Wrap it up',
  CODE_SESSION_WRAP_CONFIRM_NO: 'Leave it open',
  CODE_SESSION_WRAP_SENT: 'Finishing up. It closes on its own.',
  CODE_SESSION_WRAP_FAILED: "Couldn't reach this agent",
  // Why the button is missing rather than dead. The old proxy cannot say which
  // process the agent is, so closing it would leave the agent running.
  CODE_SESSION_WRAP_UNAVAILABLE: 'Restart this agent once to close it from here.',
  // Shared work groups. Never "score"/"attention" -- these are what Roy does next.
  // Each HINT is the box's hover, saying how a row got in there.
  CODE_ATTENTION_TALK: 'Stuck without you',
  CODE_ATTENTION_TALK_HINT: 'They asked a question or hit something they cannot decide alone.',
  CODE_ATTENTION_WAIT: 'Going fine on their own',
  CODE_ATTENTION_WAIT_HINT: 'Still working, nothing to answer. Notes nobody read sit here too.',
  CODE_ATTENTION_WRAP: 'Finished, safe to close',
  CODE_ATTENTION_WRAP_HINT: 'Done and asked nothing. Closing one frees it up.',
  CODE_ATTENTION_CHECKING: 'Checking who needs you…',
  CODE_ATTENTION_UNCHECKED: 'Could not check who needs you. Showing the usual order.',
  CODE_ATTENTION_TALK_EMPTY: 'Nobody needs you right now.',
  CODE_ATTENTION_WAIT_EMPTY: 'Nobody is working on their own.',
  CODE_ATTENTION_WRAP_EMPTY: 'Nothing to close.',
  CODE_ATTENTION_NOT_CONNECTED: 'Not connected right now, so there is no session to open.',
  CODE_TAB_KEYS: 'Keys',
  CODE_TAB_NEEDS: 'Needs you',
  CODE_TAB_SESSIONS: 'Sessions',
  CODE_TAB_FACTORY: 'Factory',
  CODE_NEEDS_WAITING: 'Waiting',
  CODE_NEEDS_REPLY: 'Waiting on your reply',
  CODE_NEEDS_ANSWERED: 'Answered',
  CODE_NEEDS_ANSWER_ONE: 'Answer one at a time',
  CODE_TAB_INFRA: 'Infrastructure',
  CODE_TAB_MADE: 'Pages and apps',
  CODE_TAB_REPORTS: 'Reports',
  REPORTS_NO_PROJECT: 'Add a project to see its numbers.',
  REPORTS_NO_FOLDER: 'This project has no folder on this Mac, so there is nothing to measure yet.',
  REPORTS_EMPTY_TITLE: 'Know what to do next, not just what happened',
  REPORTS_EMPTY_BODY:
    'An agent picks the 3-6 numbers that decide your next move - keep the ads or cut them, fix the page or buy more traffic - and hooks them up to the services this project already uses. After that they refresh here for free.',
  REPORTS_SET_UP: 'Set up reports',
  REPORTS_SETTING_UP: 'An agent is building your reports',
  REPORTS_OPEN_AGENT: 'Open',
  REPORTS_INVALID: 'The reports file has a problem, so no numbers can show.',
  REPORTS_FIX: 'Fix it',
  REPORTS_TRY_AGAIN: 'Try again',
  REPORTS_STARTING: 'Starting an agent…',
  REPORTS_AGENT_FIXING: 'Agent fixing · Open',
  REPORTS_REFRESH: 'Refresh',
  REPORTS_REFRESHING: 'Refreshing…',
  REPORTS_UPDATED: 'Updated',
  REPORTS_NEEDS_DECISION: 'to decide',
  REPORTS_PLAN_FIX: 'Plan a fix',
  REPORTS_DECIDED: 'Mark as done',
  REPORTS_SHOW_CALL: 'Show the first one',
  REPORTS_ALL_ON_TRACK: 'All on track',
  REPORTS_TARGET: 'Target',
  REPORTS_YOU: 'You',
  REPORTS_TYPICAL: 'Typical',
  REPORTS_TOP_QUARTER: 'Top quarter',
  REPORTS_TYPICAL_FOR: 'Typical for',
  REPORTS_TYPICAL_SOURCE: 'Source',
  REPORTS_STAND: 'Where you stand among',
  REPORTS_STAND_TOP: 'You are in the top quarter of',
  REPORTS_FUNNEL: 'Where people drop off',
  REPORTS_FUNNEL_EACH: 'each',
  REPORTS_FUNNEL_OF: 'of',
  REPORTS_LEAK: 'The leak',
  REPORTS_LEAK_SHORT: 'short of typical for',
  REPORTS_LEAK_HINT: 'Fix this step before paying to bring more people in.',
  REPORTS_LAST_GOOD: 'Last good',
  REPORTS_BROKEN: "Couldn't get this number",
  REPORTS_VS_PREVIOUS: 'vs the',
  REPORTS_DAYS_BEFORE: 'days before',
  REPORTS_RANGE_7: '7 days',
  REPORTS_RANGE_30: '30 days',
  REPORTS_MORE: 'more',
  REPORTS_SOURCE: 'Check the source',
  REPORTS_RAIL_TITLE: 'Numbers',
  REPORTS_RAIL_EMPTY: 'See the numbers that decide what this project does next.',
  REPORTS_RAIL_OPEN: 'Open Reports',
  REPORTS_HOME: 'All projects',
  REPORTS_HOME_EMPTY: 'No project has numbers yet. Pick one on the left to set it up.',
  REPORTS_NOT_SET_UP: 'No numbers yet',
  REPORTS_REFRESH_ALL: 'Refresh all',
  CODE_TAB_BROWSER: 'Browser',
  CODE_KEYS_EVERYWHERE: 'Everywhere',
  CODE_KEYS_SCAN: 'Scan again',
  CODE_KEYS_CLOUD_NO_ACCESS: "the account you're signed in with can't see this project, so its keys aren't counted",
  CODE_KEYS_CLOUD_SIGNED_OUT: "you're signed out, so its keys aren't counted",
  CODE_KEYS_SCANNING: 'Scanning…',
  CODE_KEYS_ADD: 'Add key',
  CODE_KEYS_READY_COUNT: 'ready',
  CODE_KEYS_MISSING_COUNT: 'missing',
  CODE_KEYS_EXPIRING_COUNT: 'expiring',
  CODE_KEYS_MISSING_HEAD: 'Missing',
  CODE_KEYS_MISSING_EMPTY: 'Nothing missing here.',
  CODE_KEYS_OPTIONAL_HEAD: 'Works without these',
  CODE_KEYS_OPTIONAL_NOTE: 'The app runs fine if you never add them. Adding one turns on extra.',
  CODE_KEYS_OPTIONAL_CLI: 'Your signed-in command line already covers this.',
  CODE_KEYS_READY_HEAD: 'Ready',
  CODE_KEYS_CLOUD_HEAD: 'Live on the service',
  CODE_KEYS_CLOUD_NOTE: 'These live on that service, not on this Mac.',
  CODE_KEYS_HIDDEN_ONE: 'hidden',
  CODE_KEYS_HIDDEN_MANY: 'hidden',
  CODE_KEYS_NO_FOLDER: 'Give this project a folder and I can scan it.',
  CODE_KEYS_ROW_ADD: 'Add',
  CODE_KEYS_EVIDENCE_REVEAL: 'Show in Finder',
  CODE_KEYS_SEARCH: 'Search keys…',
  CODE_KEYS_ROW_COPY: 'Copy',
  CODE_KEYS_ROW_COPIED: 'Copied',
  CODE_KEYS_ROW_CHECK: 'Check',
  CODE_KEYS_ROW_EDIT: 'Edit',
  CODE_KEYS_ROW_HIDE: 'Hide',
  CODE_KEYS_ROW_UNHIDE: 'Unhide',
  CODE_KEYS_ROW_REMOVE: 'Remove',
  CODE_KEYS_ROW_COPY_TIP: 'Copy this key',
  CODE_KEYS_ROW_CHECK_TIP: 'Test that this key still works',
  CODE_KEYS_ROW_EDIT_TIP: 'Change its service, expiry or note',
  CODE_KEYS_ROW_HIDE_TIP: 'Hide this key from the list',
  CODE_KEYS_ROW_UNHIDE_TIP: 'Show this key in the list again',
  CODE_KEYS_ROW_REMOVE_TIP: 'Remove this key',
  CODE_KEYS_ROW_SAVE: 'Save',
  CODE_KEYS_ROW_CANCEL: 'Cancel',
  CODE_KEYS_REMOVE_TITLE: 'Remove this key?',
  CODE_KEYS_REMOVE_FORGET: 'Forget it here',
  CODE_KEYS_REMOVE_DELETE: 'Delete the value too',
  CODE_KEYS_EXPIRED: 'expired',
  CODE_KEYS_ADD_TITLE: 'Add a key',
  CODE_KEYS_ADD_INTRO: 'Paste the key. We work out which service it is for.',
  CODE_KEYS_ADD_VALUE: 'Value',
  CODE_KEYS_ADD_NAME: 'Name',
  CODE_KEYS_ADD_PROVIDER: 'Provider',
  CODE_KEYS_ADD_WHERE: 'Where',
  CODE_KEYS_ADD_EXPIRES: 'Expires',
  CODE_KEYS_ADD_NOTE: 'Note',
  CODE_KEYS_USED_BY: 'Used by',
  MCP_TITLE: 'Connected apps',
  MCP_ADD: 'Add app',
  MCP_CHECKING: 'Checking…',
  MCP_CONNECTED: 'Connected',
  MCP_NEEDS_LOGIN: 'Needs sign-in',
  MCP_FAILED: "Can't connect",
  MCP_PENDING: 'Waiting for your OK',
  MCP_WHERE_USER: 'Everywhere',
  MCP_WHERE_LOCAL: 'This folder',
  MCP_WHERE_PROJECT: 'This repo, for everyone',
  MCP_WHERE_CLAUDE_AI: 'Your claude.ai account',
  MCP_SIGN_IN: 'Sign in',
  MCP_SIGNING_IN: 'Finish signing in in your browser…',
  MCP_EDIT: 'Edit',
  MCP_REMOVE: 'Remove',
  MCP_MANAGE_ON_CLAUDE_AI: 'Manage on claude.ai',
  MCP_RECHECK: 'Check again',
  MCP_EMPTY: 'No apps connected yet. Add one so the agent can use it.',
  MCP_NEW_SESSIONS: 'Saved. New sessions can use it.',
  MCP_SHEET_ADD_TITLE: 'Connect an app',
  MCP_SHEET_EDIT_TITLE: 'Edit app',
  MCP_SHEET_INTRO: "Pick an app to sign in to it, or paste any app's address or setup snippet.",
  MCP_POPULAR: 'Popular apps',
  MCP_KIND_URL: 'Web address',
  MCP_KIND_COMMAND: 'Command',
  MCP_NAME: 'Name',
  MCP_NAME_TAKEN: 'An app with this name is already connected.',
  MCP_NAME_INVALID: 'Letters, numbers, dashes and dots only.',
  MCP_URL: 'Address',
  MCP_COMMAND: 'Command',
  MCP_HEADERS: 'Headers',
  MCP_ENV: 'Environment variables',
  MCP_ADD_ROW: 'Add',
  MCP_WHERE: 'Where',
  MCP_SAVE: 'Save',
  MCP_SAVING: 'Saving…',
  MCP_REMOVE_TITLE: 'Remove this app?',
  MCP_REMOVE_BODY: 'New sessions will not be able to use it. You can add it again later.',
  SLASH_MCP: 'See, add and sign in to connected apps',
  SLASH_SKILLS: 'Browse your skills',
  SLASH_COMPACT: 'Shrink the conversation to free up room',
  SLASH_CLEAR: 'Start over with a clean conversation',
  SLASH_INIT: 'Write a CLAUDE.md for this folder',
  SLASH_REVIEW: 'Review the current changes',
  SLASH_EMPTY: 'No command matches',
  SLASH_SKILLS_TITLE: 'Skills',
  SLASH_SKILLS_SEARCH: 'Find a skill',
  SLASH_SKILLS_NONE: 'No skills in ~/.claude/skills yet.',
  SLASH_CLOSE: 'Close',
  CODE_KEYS_USED_BY_ALL: 'Every project',
  CODE_KEYS_LOOKS_LIKE: 'Looks like the same key as',
  CODE_KEYS_ADD_SAVE: 'Save to keychain',
  CODE_KEYS_ADD_SAVING: 'Saving…',
  CODE_KEYS_ADD_NAME_INVALID: 'Use capital letters, numbers, underscores.',
  CODE_KEYS_ADD_UNKNOWN_PROVIDER: 'Not sure which service this is',
  // Swipe deck. Says what the gesture DOES, never "left"/"right" -- the arrows
  // are on screen and the words are what someone reads to learn the rule.
  SWIPE_DECK_OPEN: 'Stack',
  SWIPE_DECK_TITLE: 'Answer agents',
  // Back from a card lands on that card, not the list, so it cannot borrow the
  // detail's usual "All sessions".
  SWIPE_DECK_BACK: 'Back',
  SWIPE_DECK_CLOSE: 'Close',
  SWIPE_DECK_SKIP: 'Later',
  SWIPE_DECK_AFFIRM: 'Send',
  SWIPE_DECK_PICK_FIRST: 'Pick one first.',
  SWIPE_DECK_TYPE_PLACEHOLDER: 'Tell it what to do…',
  SWIPE_DECK_MORE_QUESTIONS: 'It asked more than one thing. Open it to answer.',
  SWIPE_DECK_NOTHING_TO_DO: 'Nothing you can send this one right now.',
  SWIPE_DECK_EMPTY: 'All caught up.',
  SWIPE_DECK_EMPTY_DETAIL: 'Nothing is waiting on you.',
  // End of a run that passed on some. Counts them, because "you skipped some"
  // is not a thing anyone can act on and a number is.
  SWIPE_DECK_END: "That's everyone.",
  SWIPE_DECK_END_AGAIN: 'Go through them again',
  SWIPE_DECK_SEND_FAILED: "Couldn't reach this agent",
  // The reveal happened on the Mac, which is the one screen the person
  // holding the phone is not looking at -- so the phone has to say so.
  CODE_SESSION_GOTO_DONE: "It's open on your computer",
  CODE_SESSION_GOTO_MISSING: "Couldn't find that window on your Mac",
  CODE_SESSION_ZOOM_MISSING: "Couldn't resize that agent on your Mac",
  // On-demand suggestions in session detail. Chips FILL the reply box, so the
  // button promises ideas, not actions.
  CODE_SESSION_SUGGEST: 'What should I say next?',
  CODE_SESSION_SUGGEST_AGAIN: 'Show me others',
  CODE_SESSION_SUGGEST_HIDE: 'Hide these',
  CODE_SESSION_SUGGEST_HIDE_WORD: 'Hide',
  CODE_SESSION_AUTO_PICK: 'Send the first idea by itself',
  CODE_SESSION_AUTO_PICK_OFF: 'Off',
  CODE_SESSION_AUTO_PICK_STOP: 'Stop - I will answer this one',
  CODE_SESSION_RETRY: 'Try again',
  CODE_SESSION_RESUME_STALLED: 'It did not start back up. Your message is back in the box.',
  REPLY_CLOSE: 'Close',
  REPLY_EMPTY: 'Nothing is waiting for your reply. When an AI agent asks you something, it shows up here.',
  CODE_SESSION_SUGGEST_BUSY: 'Thinking…',
  CODE_SESSION_SUGGEST_LOADING: 'Thinking of replies…',
  CODE_SESSION_SUGGEST_NONE: 'No ideas for this one right now.',
  // Phone mic setup. Says what they get ("use your phone as the mic"), never
  // "install a HAL plugin". The password and the audio blip are macOS facts,
  // so they are stated up front rather than sprung on the user.
  PHONE_MIC_INSTALL: 'Use your phone as a microphone?',
  PHONE_MIC_INSTALL_DETAIL:
    'One time setup so any app can hear your phone. Your Mac will ask for your password, and sound will skip for a second.',
  PHONE_MIC_INSTALL_CONFIRM: 'Set Up',
  PHONE_MIC_INSTALL_CANCEL: 'Not Now',
  PHONE_MIC_READY: 'Your phone is ready to use as a microphone.',
  PHONE_MIC_READY_DETAIL: 'Pick MightyMouse as the microphone in any app.',
  PHONE_MIC_INSTALL_FAILED: 'That setup did not finish.',
  // Cancelling the password sheet is a choice, so it reads as one. Both
  // endings promise the same way back, since the offer returns on the next
  // mic tap and nothing has to be hunted for in Settings.
  PHONE_MIC_SKIPPED: 'No problem, skipped for now.',
  PHONE_MIC_INSTALL_FAILED_DETAIL:
    'Your phone mic still works inside MightyMouse. Turn the mic on again to set this up.',
  RECOVERED_ONE: 'We found your last recording',
  RECOVERED_MANY: 'We found {n} recordings',
  RECOVERED_WORKING: 'Getting your last recording back…',
  RECOVERED_DETAIL: 'It got cut off when MightyMouse closed. It is saved in your Library.',
  RECOVERED_DETAIL_MANY: 'They got cut off when MightyMouse closed. They are saved in your Library.',
  RECOVERED_NO_WORDS: 'No words were heard in this one.',
  RECOVERED_COPY: 'Copy Text',
  RECOVERED_COPIED: 'Copied',
  RECOVERED_OPEN: 'Open in Library',
  RECOVERED_LATER: 'Later',
  SETTINGS: 'Settings',
  SIMPLE_CODE_PROMPT: 'Run AI coding agents on this Mac',
  SIMPLE_CODE_DETAIL: 'Claude Code, Codex and more, side by side. Work right here on your Mac, or from your phone',
  SIMPLE_CODE_OFF_NOTE: 'Off: just the phone remote and voice typing',
  SETTINGS_MENU: 'Settings…', // tray/menu variant with ellipsis
  CUSTOM_INSTRUCTIONS: 'Custom Instructions',
  CUSTOM_INSTRUCTIONS_HINT: 'Tell it how you like things done. It follows this every time.',
  CUSTOM_INSTRUCTIONS_PLACEHOLDER: 'e.g. Keep replies short. Skip the preamble. Use metric.',
  // Act highlight (Settings). Named for what the user gets (a look at what it
  // is about to touch), not the mechanic ("act mode draws a dashed box").
  // Old copy also carried an em dash, which the voice rules ban outright.
  SHOW_BEFORE_ACTING: 'Show me before it acts',
  SHOW_BEFORE_ACTING_HINT:
    'Marks the spot on screen a moment before it clicks or types there. Nothing happens without a heads up.',
  // Screen recording. "Recording" alone was ambiguous: this app also records
  // your VOICE for dictation, and the two have separate settings. Every label
  // here says "screen" so nobody changes the wrong one.
  SCREEN_RECORDING: 'Screen recording',
  SCREEN_RECORDING_MAX: 'Stop screen recording after',
  SCREEN_RECORDING_MAX_HINT: 'Recordings stop on their own, in case you forget one is running.',
  // Capture HUD / Dynamic Island: "capture" is our word, not the user's.
  CAPTURE_HUD: 'Show a recording card',
  CAPTURE_HUD_HINT: 'A small card appears while recording, so you can see it is running.',
  DYNAMIC_ISLAND_HINT: 'Show what it is doing near the notch, like a live activity.',
  // Selection bar. Benefit, not mechanic: the user gets a rewrite without
  // reaching for a hotkey, so the label says what appears and what it does.
  SELECTION_BAR: 'Offer to fix text I highlight',
  SELECTION_BAR_HINT:
    'Highlight any text and a small bar pops up. One tap to fix the grammar, make it shorter, or ask about it.',
  SELECTION_BAR_FAST: 'Fast mode',
  SELECTION_BAR_FAST_HINT:
    'Get your rewrite back in about a second, instead of waiting for your own AI to start up. Uses your plan usage.',
  SELECTION_BAR_FAST_SIGNED_OUT: 'Sign in to use Fast mode.',
  SELECTION_BAR_FAST_NO_CREDITS: 'You have used all your usage. Add more to keep using Fast mode.',
  SELECTION_BAR_FAST_TIMEOUT: 'That took too long. Try again.',
  SELECTION_BAR_FAST_FAILED: 'Could not rewrite that. Try again.',
  // A 5xx/404 is OUR bug, not a blip: "try again" sent users into a loop that
  // could never succeed while Fast was down for everyone (dead Groq model id).
  SELECTION_BAR_FAST_BROKEN: 'Fast mode is down on our side. We have been told.',
  SELECTION_BAR_RETRY: 'Try that again',
  SELECTION_BAR_PICK_ANOTHER: 'Ask for something else',
  SELECTION_BAR_ASK_PLACEHOLDER: 'What do you want done to this?',
  SELECTION_BAR_HISTORY: 'History',
  SELECTION_BAR_HISTORY_EMPTY: 'Nothing yet. Fix or ask about some text and it shows up here.',
  // The row's action. Says where it goes, because the old selection is gone and
  // it lands on whatever is highlighted now.
  SELECTION_BAR_HISTORY_PASTE: 'Paste this',
  SELECTION_BAR_HISTORY_FAILED: 'Did not work',
  SELECTION_BAR_RUNNING: 'Working…',
  SELECTION_BAR_DONE: 'Done',
  LIVE_COMPANION_HINT:
    'Just talk, and get an answer read back to you. Opens a little character in the corner that listens while it is on.',
  // The HUD card for a live hands-free session — the Mac's answer to the
  // phone's HandsFreePill, so one mode reads the same on both surfaces. The
  // title says "Hands-free", never plain "Listening", because telling the two
  // modes apart at a glance is the whole point of the card.
  HANDS_FREE_HUD: '🎙 Hands-free',
  // The speech model loads first. Saying so beats a mic that looks live but
  // drops the first sentence.
  HANDS_FREE_HUD_STARTING: 'warming up…',
  // Names the way out. A mode with no visible off switch is the one people
  // force-quit the app to escape.
  HANDS_FREE_HUD_LISTENING: 'talk anytime · tap the hotkey to stop',
  HANDS_FREE_HUD_SPEAKING: 'hearing you…',
  HANDS_FREE_SEGMENT_HUD: '🎙 Heard',
  HANDS_FREE_SEGMENT_WORKING: 'writing it down…',
  HANDS_FREE_HUD_DONE: 'Hands-free off',
  HANDS_FREE_HUD_FAILED: 'Hands-free could not start',
  // Names the one fix that works. A mic that never starts is nearly always an
  // unanswered or denied permission prompt, not a broken model.
  HANDS_FREE_HUD_MIC_TIMEOUT: 'Mic did not start. Check Microphone access in System Settings',
  // Run details: "run" and "transcript" are internal words.
  RUN_DETAILS: 'Show what it did',
  RUN_DETAILS_HINT:
    'Adds an expand button to each result so you can see every step it took. Handy when something looks wrong.',
  AGENT_PHOTOS: 'Photo access for agents',
  AGENT_PHOTOS_HINT:
    'Let an agent ask for a photo from your phone. It only ever sees the ones you pick.',
  DECISION_CARDS: 'Show how sure the agent is',
  DECISION_CARDS_HINT:
    'When an agent asks you to choose, it scores each option so the card can show which one it would pick and why. Uses a few more tokens per question.',
  CONTEXT_LOG: 'Remember what I am working on',
  CONTEXT_LOG_HINT: 'Keeps track of what you are doing so answers fit your work.',
  // Feedback: lead with what it does for them, not the mechanic.
  FEEDBACK_LEARNING: 'Learn from my feedback',
  FEEDBACK_LEARNING_HINT:
    'Rate an answer and say what you wanted instead. It uses your recent corrections to do better next time.',
  // Transcription speed readout. "Transcribe" is our word — the user's is "turn
  // what I said into text", so the label talks about the wait, not the process.
  SHOW_TIMING: 'Show how long things take',
  SHOW_TIMING_HINT:
    'Puts a small number on your dictation cards, chat replies, and past runs, so you can see how long each one took.',
  // Auto-paste: "transcription" is jargon for "what you said".
  FN_LISTEN: 'Use the fn key to talk',
  FN_LISTEN_HINT:
    'Tap the fn (globe) key to start and stop talking, instead of holding three keys. Double-tap and hold work the same as the normal shortcut. If your fn key already opens emoji, it will still do that too.',
  AUTO_PASTE: 'Paste what I say',
  AUTO_PASTE_HINT: 'Drops your words straight into whatever app you are in.',
  SMART_LISTEN: '✨ Smart Listen',
  SMART_LISTEN_SUBTITLE: 'reading your screen…',
  PAIRING_CODE_PROMPT: 'Added MightyMouse to your Home Screen? Pair it with a code instead.',
  PAIRING_CODE_SHOW: 'Pairing code',
  PAIRING_CODE_NEW: 'New code',
  PAIRING_CODE_HIDE: 'Hide',
  PAIRING_CODE_ENTER: 'Type these 6 digits on your phone.',
  // Fallback only, for the frame before the deadline arrives from the Mac.
  PAIRING_CODE_EXPIRES: 'Expires in 5 minutes',
  PAIRING_CODE_EXPIRES_IN: 'Expires in',
  PAIRING_CODE_EXPIRED: 'Expired - tap New code',
  HISTORY_MENU: 'History…',
  // Tray entry shown when finished runs are unread (count badge → one obvious click).
  // `{n}` is replaced with the unread count.
  HISTORY_UNREAD_MENU: '{n} new. Open History',
  CHEAT_SHEET_MENU: 'Cheat Sheet…',
  SETUP_MENU: 'Setup & Health…',
  ADVANCED_SUBMENU: 'Advanced', // tray submenu: features (DI, Incognito, History, …) — everyone
  ZOOM_MENU: 'Zoom: {pct}%',
  ZOOM_IN_MENU: '+  Zoom In',
  ZOOM_OUT_MENU: '−  Zoom Out',
  ZOOM_RESET_MENU: 'Reset to 100%',
  ADMIN_SUBMENU: 'Admin', // tray submenu: platform + dev escape hatches — admin only
  RESTART_MENU: 'Restart App', // tray entry (lives under Admin submenu)
  VIEW_AS_USER_MENU: 'View as user', // tray: hide every admin surface app-wide (a toggle, so no ellipsis)
  ONE_SCREEN_SETUP_MENU: 'One-screen setup (preview)…', // tray: opens the new setup screen without touching real first run
  VIEW_AS_USER_EXIT: '👁 Viewing as user · back to admin', // the preview's only visible way out
  ACTIVE_COPY_SUBMENU: 'Shortcuts & Claude Code go to', // tray: only when two copies run at once
  ACTIVE_COPY_THIS_ONE: '(this one)',
  PERMISSIONS_BUTTON: 'Permissions', // Settings title-bar button → wizard
  CONTEXT_PREFIX: 'context', // toggle label prefix (was the cryptic "ctx")
  // Hover tooltip explaining what the context toggle does
  CONTEXT_TOOLTIP: 'Sends a bit of extra context so it understands what you’re doing.',
  // Default icon a brand-new shortcut gets — a REAL stored value (not a ghost
  // placeholder), so the icon field and the pill always show the same glyph and
  // it reads as an editable default, not "unset".
  SHORTCUT_DEFAULT_ICON: '⚡',
  SHORTCUT_ICON_PICK_HINT: 'Pick an icon',
  SKILL_ADD: '+ Action', // labeled button that opens the shortcuts editor
  SKILL_ADD_TOOLTIP: 'Save an instruction you reuse as a one-tap action.',
  SKILL_EDIT_TOOLTIP: 'Edit your actions.',
  // Shortcuts editor modal copy (a shortcut = a one-tap saved instruction; the
  // pills in the panel are the shortcuts themselves).
  SKILL_EDITOR_TITLE: 'Your actions', // modal header
  SKILL_EDITOR_SUBTITLE: 'One-tap instructions you can reuse anywhere.', // under the header
  SKILL_EDITOR_EMPTY: 'No actions yet. Add one to get a one-tap instruction.',
  SKILL_EDITOR_ADD: 'Add action', // "+" button in the modal
  SKILL_EDITOR_SAVE: 'Save',
  SKILL_EDITOR_SAVING: 'Saving…',
  SKILL_EDITOR_NEEDS_NAME: 'Every action needs a name.',
  SKILL_EDITOR_UNNAMED: 'Untitled action',
  SKILL_FIELD_ICON: 'Icon',
  SKILL_FIELD_NAME: 'Name',
  SKILL_FIELD_MODE: 'Mode',
  SKILL_FIELD_BODY: 'What it does',
  SKILL_FIELD_BODY_HINT: 'The instruction that runs on tap. Type / to drop in one of your skills.',
  SKILL_NAME_PLACEHOLDER: 'e.g. Tweet style',
  SKILL_BODY_PLACEHOLDER:
    'Type the instruction that runs when you tap this shortcut. Type / to insert one of your skills.',
  SKILL_REMOVE_TOOLTIP: 'Remove action',
  // Appended to the mode-badge tooltip (after the active mode's explainer)
  MODE_CYCLE_HINT: 'Click to switch.',
  // Hover tooltip on the ↻ icon at the end of a history row
  REUSE_TOOLTIP: 'Reuse this. Drops it back in the box.',
  // Hover tooltip on the continue icon at the end of a history row
  CONTINUE_TOOLTIP: 'Continue this chat.',
  // Same button on a capture row (listen/recording/screenshot). There's no chat to
  // continue there — the transcript becomes the first message of a new one.
  START_CONVO_TOOLTIP: 'Start a chat from this.',
  ROUTE_TOOLTIP: 'Send this to an app or agent.',
  ROUTE_FINDING_TOOLTIP: 'Finding where it goes…',
  ROUTE_NEXT_TOOLTIP: 'When you stop, this opens the list of places to send it.',
  SUBMIT_NEXT_TOOLTIP: 'When you stop, your words get pasted and sent for you.',
  // Hover tooltip on the folder icon at the end of a history row
  HISTORY_OPEN_FOLDER_TOOLTIP: 'Open this run in Finder.',
  // Chip on a history row whose run never finished. Deliberately NOT "failed":
  // the agent didn't fail, the app died while it was working. Saying "failed"
  // would blame the wrong thing.
  HISTORY_ROW_INTERRUPTED: 'stopped early',
  HISTORY_ROW_INTERRUPTED_TOOLTIP: `${appName} quit while this was running.`,
  // Chip on a row whose run is still going (written at spawn, not settled yet).
  HISTORY_ROW_RUNNING: 'running',
  HISTORY_ROW_RUNNING_HINT: 'Still working on this one.',
  HISTORY_ROW_FAILED: 'failed',
  HISTORY_SEARCH: 'Search what you said or asked…',
  HISTORY_SEARCH_EMPTY: 'Nothing found for "{q}".',
  // Shown under a failed history row. Each says what to DO about it -- a reason
  // the user can't act on is just noise.
  RUN_FAIL_REASON: {
    error: 'Something went wrong. Try running it again.',
    timeout: 'This took too long and was stopped.',
    out_of_credits: 'You ran out of usage. Upgrade or add extra usage to run this again.',
    stopped: 'You stopped this one.',
    spawn_failed: "Couldn't start the AI tool. Check it's installed in Settings.",
    signed_out: 'Sign in on your computer to run this.',
    rate_limited: 'Rate limited. Wait a bit and try again.',
    broken: 'This broke on our side. We have been told.'
  },
  // Fallback: every row written before the reason field existed has none.
  RUN_FAIL_UNKNOWN: 'This one failed.',
  RUN_FAILED_TOAST: 'That one failed.',
  RUN_DONE_OK: 'Done',
  // Shown for the few seconds between the stop and the words arriving, so a
  // kept clip is never silent about what it's doing.
  CLIP_PHONE_TEXT_PENDING: 'Writing down what you said...',
  // The words never came back -- almost always the app losing its slice of
  // time in the background. The recording is fine, so this is not a failure.
  CLIP_PHONE_TEXT_SLOW: 'Still saved. Your Mac will type it out.',
  // The phone couldn't write out the words. Each one leads with the WORDS
  // being missing, never with "saved" -- the recording being safe is assumed,
  // and saying it first answers a question the user never asked.
  CLIP_PHONE_TEXT_FAILED: {
    denied: "Can't show your words here. Turn on speech in Settings.",
    unsupported: "This phone can't show your words. Your Mac will type them out.",
    failed: "Couldn't make out the words here. Your Mac will type them out.",
    heardNothing: "Didn't pick anything up. Check your mic isn't covered."
  },
  // Inline prompt shown in the Panel thread when balance = $0
  OUT_OF_CREDITS: `You have used all your usage. Upgrade or add extra usage to keep using ${appName}.`,
  // Hover tooltip on the panel's "open full chat" button (opens the Mighty window)
  MIGHTY_OPEN_TOOLTIP: 'Open a new chat in the big window.',
  MIGHTY_RESUME_TOOLTIP: 'Open this chat in the big window.',

  TOUR_CONFIRM_IDLE: 'Hold ⌘ ⌥ ⇧ and tap {glyph}',
  // The one-key path (fn). No chord, so no two mini-steps and no hold copy.
  TOUR_CONFIRM_SOLO_IDLE: 'Tap the {glyph} key',
  TOUR_CONFIRM_CONFIRMED: 'Nice, that’s the one.',
  TOUR_CONFIRM_WRONG: 'Close. It’s {glyph} for this one.',
  TOUR_CONFIRM_UNLOCKED: 'No luck? Skip ahead, we’ll help you fix it later.',
  // Eyebrow on a step whose shortcut has a `mnemonic` — replaces TOUR_TRY_IT_NOW
  // so the memory hook sits in the loudest slot instead of adding a third line
  // of copy under the caps. `{glyph}` = the cap, `{word}` = the mnemonic.
  TOUR_MNEMONIC: '{glyph} is for {word}',
  // Subtitle under either escalation line. Says the exit is not one-way, which
  // is the actual worry behind "my hotkeys don't work" on a first run.
  TOUR_HINT_REVISIT: 'You can always revisit this tour from Settings.',
  // Next button label while a hotkey step is armed and un-pressed (§4.3).
  TOUR_NEXT_WAITING: 'Press the keys',
  // Same gate, one-key (fn) path — "keys" plural is wrong when there's one cap.
  TOUR_NEXT_WAITING_SOLO: 'Press the key',
  // Eyebrow ABOVE the caps. The state line under them reads as a caption, so
  // on its own nothing told the user the caps were a thing to DO — this is
  // the instruction, and it's why the caps get an accent label not a grey one.
  TOUR_TRY_IT_NOW: 'Try it now',
  // Replaces the eyebrow once the press lands, so the row stops asking.
  TOUR_TRY_IT_DONE: 'You got it',
  // Shown on the final step only if all three hotkey steps timed out without
  // a single press landing (§7.1 decision) — one quiet line, not a new surface.
  TOUR_SHORTCUTS_NOT_RESPONDING: 'Your shortcuts aren’t responding. We’ll help you fix that.',
  TOUR_FIX_IT: 'Fix it',
  TOUR_SKIP_TOUR: 'Skip tour',
  TOUR_SKIP_STEP: 'Skip this step',

  // ── Tour phone-pairing step. Same voice as the hotkey copy: short, warm,
  // no em dashes, never blames the user for a network they can't see.
  TOUR_PHONE_SCAN: 'Point your phone’s camera at the code',
  TOUR_PHONE_CONFIRMED: 'Your phone’s connected.',
  // The step still works if pairing doesn't — Settings is always the way back.
  TOUR_PHONE_UNLOCKED: 'Not now? You can pair anytime from Settings.',
  // Shown instead of the QR when there's no Wi-Fi address to pair on. A dead
  // end for THIS step, so it says where to go rather than offering a retry
  // that would fail identically.
  TOUR_PHONE_NO_LAN: 'We’ll set this up later in Settings.',
  // The off-Wi-Fi opt-in. Says what it GETS you, not what it does technically
  // (nobody is here to think about tunnels), and stays honest that it reaches
  // this Mac from outside the house.
  TOUR_PHONE_TUNNEL_TOGGLE: 'Also use it away from home',
  TOUR_PHONE_NEXT_WAITING: 'Scan to continue',

  // Panel "Finish setup" card. Row labels are outcomes, not internal step
  // names ("first_run", "transcribe") — same rule as everywhere else.
  CHECKLIST_TITLE: 'Finish setup',
  CHECKLIST_PERMISSIONS: 'Grant permissions',
  CHECKLIST_BACKEND: 'Connect a backend',
  CHECKLIST_FIRST_RUN: 'Run your first rewrite',
  CHECKLIST_TRANSCRIBE: 'Try transcribe',
  CHECKLIST_PHONE: 'Pair your phone',
  CHECKLIST_REMAINING: '{n} of {total} left',
  CHECKLIST_DONE: "Setup's complete. Everything's switched on.",
  CHECKLIST_DONE_ACTION: 'Got it',

  RESOURCES_MENU: "What's using my Mac…",
  RESOURCES_EMPTY: 'Nothing is working hard right now.',
  RESOURCES_LOADING: 'Reading what your Mac is doing…',
  RESOURCES_ERROR: "Couldn't read what's running right now.",
  RESOURCES_RETRY: 'Try again',
  RESOURCES_NAME_COL: 'App',
  RESOURCES_CORES_COL: 'CPU',
  RESOURCES_MEM_COL: 'Memory',
  RESOURCES_TREND_COL: 'Last 2 min',
  RESOURCES_SYSTEM_PROCESS: 'System process',
  RESOURCES_FREE: 'free',
  RESOURCES_SWAP: 'Swap',
  RESOURCES_OF: 'of {n}',
  RESOURCES_NONE: 'None',
  RESOURCES_OTHER: 'Other',
  RESOURCES_ONE_PROCESS: '1 process',
  RESOURCES_PROCESSES: '{n} processes',
  RESOURCES_ASK: 'Ask about this',
  RESOURCES_ASKED: 'Ready to send. Press Return.',
  RESOURCES_CLOSE: 'Close',
  RESOURCES_TREND_WAIT: 'Watching it now'
} as const)
