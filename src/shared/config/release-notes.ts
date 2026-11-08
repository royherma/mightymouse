// Per-version release notes, newest first. Rendered in the Admin release tab
// and the What's New panel. Split out of config.ts: 1,399 lines of pure data
// that every reader of a nearby constant would otherwise have to scroll past.

export const RELEASE_NOTES = [
  {
    version: '0.55.0',
    date: '2026-11-07',
    changes: [
      {
        icon: '💻',
        title: 'Coding agents get their OWN cloud computer.',
        detail:
          'On paid plans, start Claude or Codex from the Code tab and it keeps working after you close your laptop. Tap Open preview to see what it built.'
      },
      {
        icon: '🔌',
        title: 'Your phone connects the MOMENT you scan.',
        detail: 'During setup the screen now moves on as soon as your phone pairs, instead of waiting up to 25 seconds.'
      },
      {
        icon: '⚡',
        title: 'Turn on coding agents with ONE switch.',
        detail:
          'Using just the phone remote? Settings now shows a single switch that adds Claude Code, Codex and more on your computer.'
      },
      {
        icon: '🎙️',
        title: 'History takes you STRAIGHT to your recordings.',
        detail:
          'History in the menu bar now opens your Library and clears the red count. The See saved link at the end of setup lands there too.'
      }
    ]
  },
  {
    version: '0.54.1',
    date: '2026-11-05',
    changes: [
      {
        icon: '🔍',
        title: "Your Mac's screen STAYS on your phone.",
        detail: 'Showing your Mac on your phone no longer drops and reconnects on its own a few seconds after it opens.'
      },
      {
        icon: '🖱️',
        title: 'Pinch to ZOOM, and see your fingers.',
        detail:
          "Pinch with two fingers to zoom the app in front on your Mac. A dot follows each finger, so you always see where you're touching."
      },
      {
        icon: '🎙️',
        title: "Talk while your Mac's screen is up.",
        detail:
          "Your phone's mic now records even while it shows your Mac's screen. On the Mac, tap the arrow mid-sentence to send what you said in ONE step."
      }
    ]
  },
  {
    version: '0.54.0',
    date: '2026-11-05',
    changes: [
      {
        icon: '✏️',
        title: 'See your Mac LIVE while you draw.',
        detail:
          'The picture under your sketch keeps up with your Mac, with a pause button. Turn your phone sideways and every control fits in one row, so you get the full width.'
      },
      {
        icon: '📱',
        title: 'Your Mac stays SMOOTH while your phone drives it.',
        detail:
          'Switching to Chrome or dragging the volume slider no longer freezes your Mac for a moment. Screen and display choices on the phone are now simple dropdowns.'
      },
      {
        icon: '💳',
        title: 'Pick the plan that FITS.',
        detail: 'Starter at $5, Pro at $20 and Max at $60 a month are all back. Pay yearly and get 2 months free.'
      },
      {
        icon: '💻',
        title: 'Coming from Conductor? Pick up where you left off.',
        detail:
          'Bring your Conductor chats over in one click, then open and MERGE pull requests from your Mac or phone. Cursor joins as an agent, and agents keep working with the lid closed.'
      }
    ]
  },
  {
    version: '0.53.2',
    date: '2026-10-27',
    changes: [
      {
        icon: '🔒',
        title: 'Your phone reaches your Mac SAFELY from anywhere.',
        detail:
          'If your Mac has an older copy of the secure link your phone uses away from home, it swaps in the new one the next time you connect.'
      },
      {
        icon: '🪟',
        title: 'Your phone drives a Windows PC too.',
        detail:
          "Move, click, drag, scroll and TYPE on Windows from your phone. The app switcher stays hidden on PCs where it isn't available yet."
      }
    ]
  },
  {
    version: '0.53.1',
    date: '2026-10-22',
    changes: [
      {
        icon: '📧',
        title: 'No download email after you sign up in the app.',
        detail:
          "Signing up from the app no longer sends a download email you don't need. Your sign-in email just has your code."
      },
      {
        icon: '📱',
        title: 'The phone opens straight on the trackpad.',
        detail:
          'Chat and code stay out of the way until you turn on Advanced, so the remote is the first thing you see.'
      }
    ]
  },
  {
    version: '0.53.0',
    date: '2026-10-22',
    changes: [
      {
        icon: '🔌',
        title: 'Set up in a MINUTE.',
        detail:
          "Scan the code with your phone and you're in. It opens on the trackpad, so your Mac is in your hand right away."
      },
      {
        icon: '💬',
        title: 'Chat and building are one switch away.',
        detail:
          'Turn on Advanced in Settings for chat, code and the browser. Search now finds words INSIDE your conversations, even with a typo.'
      },
      {
        icon: '✏️',
        title: 'Draw on your Mac from your phone.',
        detail:
          'Sketch with a pen, marker or pointer on your phone and it shows on your Mac screen LIVE, over any app.'
      },
      {
        icon: '🧩',
        title: 'Change any website with a SENTENCE.',
        detail:
          'Say how a site should work and the Browser writes the change. Try it, keep it, or share it with a link. Mods with code ask for a yes first.'
      },
      {
        icon: '💳',
        title: 'Two plans, nothing to decode.',
        detail:
          'Free, or Pro at $20 a month. Anyone already on another plan keeps it.'
      }
    ]
  },
  {
    version: '0.52.0',
    date: '2026-10-13',
    changes: [
      {
        icon: '↩️',
        title: 'UNDO what an agent changed.',
        detail:
          'Tap your message in a Code session to put its file edits back, and Put back if you change your mind. A new switch also gives each session its own branch.'
      },
      {
        icon: '🧠',
        title: 'Pick a model inside your Claude plan.',
        detail:
          'The picker groups every model with its price and folds away what you skip. Claude rows show their version, and Sonnet 5.5 and Haiku 5.5 are NEW.'
      },
      {
        icon: '🌐',
        title: 'Plain chat can use the browser tab TOO.',
        detail:
          'Ask in chat and it opens pages, reads them, clicks and fills forms in the Browser tab. More sites let it in, and Stop on the tab ends the run.'
      },
      {
        icon: '💬',
        title: 'Make your chats BIGGER.',
        detail:
          'Cmd+ and Cmd- zoom the chat panes while the sidebar stays put. Cmd+W closes only the panel you last touched, and Details lists the screenshots, links and files from a reply.'
      },
      {
        icon: '📱',
        title: 'Swipe BACK on your phone.',
        detail:
          'Swipe in from the left edge to leave a conversation. Chats remember where you scrolled and show a 2 new button when replies land below you.'
      }
    ]
  },
  {
    version: '0.51.0',
    date: '2026-10-06',
    changes: [
      {
        icon: '🎧',
        title: 'A real person is ONE click away.',
        detail:
          'Ask a Specialist sits in the sidebar and the menu bar menu. Write what is stuck and the reply shows up right in that window.'
      },
      {
        icon: '💳',
        title: 'Pay yearly, get two months FREE.',
        detail: 'Starter, Pro and Max now come yearly at $50, $200 and $600. Your usage still refills every month.'
      },
      {
        icon: '🧩',
        title: 'Pick a project, type, SEND.',
        detail:
          'Starting a coding session is now one box. Model, thinking and agents share one button, and Codex sessions no longer hang on Starting.'
      },
      {
        icon: '🌐',
        title: 'Ask any coding session to put it ONLINE.',
        detail: 'Claude Code and Codex can now publish a folder for you. It goes live at yourname.mightymouse.app.'
      },
      {
        icon: '⚡',
        title: 'Go BACK, like in a browser.',
        detail:
          'After you jump to another screen, a back button sits in the title bar. Cmd+[ and Cmd+] move back and forward.'
      },
      {
        icon: '📱',
        title: 'Your phone lists chats like your Mac.',
        detail:
          "Pinned first, then each project in your Mac's order, with archived chats hidden. Agents are grouped by project the same way."
      }
    ]
  },
  {
    version: '0.50.0',
    date: '2026-10-03',
    changes: [
      {
        icon: '📱',
        title: 'Change your answer before it SENDS.',
        detail:
          'On your phone, a tap now picks an answer and Send sends it. Each question names its project, and a long set ends on Check your answers.'
      },
      {
        icon: '🔌',
        title: 'Connecting your phone takes fewer steps.',
        detail:
          "Eight connect screens are gone. If your phone can't find your Mac, one screen says so and Try again is the first button."
      },
      {
        icon: '🌐',
        title: 'Point at what you want CHANGED.',
        detail:
          'In the side browser, click a spot or drag a box and type a note. A marked screenshot lands in your chat box, ready to send.'
      },
      {
        icon: '💬',
        title: 'Long links in chat got SHORT.',
        detail:
          'A web address now shows as an icon and a short name, and a file shows its file name. Hover to see the full link.'
      },
      {
        icon: '☁️',
        title: 'Your idea waits through sign-in.',
        detail:
          'Type what you want to build on the website and it is still there after you sign in and connect GitHub. It opens as a NEW build.'
      },
      {
        icon: '🧩',
        title: 'See what each session TOUCHED.',
        detail:
          "A session's Details now lists the parts of your project it changed and where it was deployed, like your website or your live app."
      }
    ]
  },
  {
    version: '0.49.0',
    date: '2026-10-02',
    changes: [
      {
        icon: '🧠',
        title: 'Pick Auto and skip choosing a model.',
        detail:
          'Auto sends quick questions to a fast AI, hard ones to a strong one, and picture or video asks to the right maker. New chats start on it.'
      },
      {
        icon: '💳',
        title: 'Your usage now REFILLS by itself.',
        detail:
          'No more dollar credits to watch. The app shows how much usage is left and when it comes back, and Free refills every week.'
      },
      {
        icon: '🌍',
        title: 'Put your project ONLINE in one click.',
        detail:
          'Press Put it online and your site gets its own address at yourname.mightymouse.app. It comes with the new $5 Starter plan.'
      },
      {
        icon: '🎨',
        title: 'Start from a look you LOVE.',
        detail:
          'Browse 32 ready styles, each with a live example page. Press Make it and the full ask lands in the chat box you already have open.'
      },
      {
        icon: '📈',
        title: '27 playbooks to grow what you built.',
        detail:
          'Each is a step by step plan with its source, picked for your kind of business. Reports show where you stand next to what is TYPICAL.'
      },
      {
        icon: '📱',
        title: 'Your phone shows you the ropes.',
        detail:
          'A first-time guide ticks off move, tap and talk as you do each one. Chat voice notes also keep working when your Mac is away.'
      }
    ]
  },
  {
    version: '0.48.0',
    date: '2026-09-30',
    changes: [
      {
        icon: '💬',
        title: 'Run SIX agents side by side.',
        detail:
          'Watch up to 6 agents work at once, or Focus on one. In All, one message box sends each job where it belongs.'
      },
      {
        icon: '🌐',
        title: 'See where your agent clicks, and TAKE over.',
        detail:
          'A cursor glides to each button it presses. Click it to Pause, Resume or Stop, and ask it to post, comment or send for you.'
      },
      {
        icon: '🧠',
        title: 'Use every Claude and ChatGPT account you have.',
        detail:
          'Settings shows how much of each plan you have used. When one runs out, your work moves to the NEXT one.'
      },
      {
        icon: '🎙️',
        title: 'Say it messy, send it SHARP.',
        detail:
          'Enhance turns a rough voice note into three cleaner versions and you pick one. A brand-new Mac starts dictating in seconds.'
      },
      {
        icon: '☁️',
        title: 'Build an app from any BROWSER.',
        detail:
          'Connect GitHub, say what you want, and it builds it in the cloud and sends the finished change to your GitHub. No Mac needed.'
      },
      {
        icon: '🖼️',
        title: 'Make images and video in the same account.',
        detail:
          'Pick Veo, Seedance, Nano Banana and more right in web chat. They use the same credits as your chats.'
      }
    ]
  },
  {
    version: '0.47.0',
    date: '2026-09-27',
    changes: [
      {
        icon: '🎧',
        title: 'Run your agents by VOICE, hands free.',
        detail:
          'Say "Hey Mighty, open the Hideout" to see every agent at once. It speaks up when one finishes or needs you, and you answer out loud.'
      },
      {
        icon: '🎙️',
        title: 'Talk over it and it stops talking.',
        detail:
          'Start speaking mid-reply and it listens to YOU instead of hearing itself. Hey Mighty also waits while you dictate or record your screen.'
      },
      {
        icon: '📁',
        title: 'Open any file right inside MightyMouse.',
        detail:
          "Click a file in chat, or press Cmd+P, and it opens as a tab you can read and edit. Saving never overwrites an agent's newer change."
      },
      {
        icon: '🧭',
        title: 'See which answer your agent recommends.',
        detail:
          'Turn on "Show how sure the agent is" in Settings. Each question then scores every choice and marks the one you USUALLY pick.'
      },
      {
        icon: '📱',
        title: 'Find any project on your phone fast.',
        detail:
          'A side menu lists your projects and recent chats, newest first with times. Suggested replies appear as cards you tap to send.'
      }
    ]
  },
  {
    version: '0.46.0',
    date: '2026-09-27',
    changes: [
      {
        icon: '📱',
        title: 'Start and steer your agents from your PHONE.',
        detail:
          "Start a chat or coding task, answer its questions, and flip through the photos and videos it makes. Tap Watch to see your Mac's screen full size."
      },
      {
        icon: '🎙️',
        title: 'Say "Hey Mighty" and it gets going.',
        detail:
          'Only what you say after its name counts. Quick asks like "open Safari and go to Gmail" happen INSTANTLY, and Cmd+Opt+Shift+V turns voice mode on or off.'
      },
      {
        icon: '🌐',
        title: 'Hand the browser a whole task.',
        detail:
          'Type a goal and it works through the pages step by step, stopping to check with you before it posts, sends or pays. Split view shows two tabs side by side.'
      }
    ]
  },
  {
    version: '0.45.0',
    date: '2026-09-25',
    changes: [
      {
        icon: '🌐',
        title: 'Sites can use your camera, mic and location.',
        detail:
          'Allow or Block once per site, and change it later from the shield in the address bar. Cmd+T, Cmd+W and your other tab shortcuts work too.'
      },
      {
        icon: '🤖',
        title: 'Your agents can use the browser TOO.',
        detail:
          'Ask one to open a page, read it, click a button or fill in a form, right in the tab beside your chat.'
      },
      {
        icon: '🔌',
        title: 'Connect your agents to GitHub, Notion and more.',
        detail:
          'Pick from 26 popular apps in one click, then add, edit or sign in to them from the side of any coding session. Type / for commands and skills.'
      }
    ]
  },
  {
    version: '0.44.1',
    date: '2026-09-25',
    changes: [
      {
        icon: '📁',
        title: 'The Running now count adds up.',
        detail:
          "The Made tab's Running now chip counted only live apps while it also listed the stopped ones. Now the number matches the rows you see."
      },
      {
        icon: '🔒',
        title: 'Passkeys stay on secure pages.',
        detail:
          'The browser beside your chat only offers your passkeys to pages on a secure connection, the same rule every major browser follows.'
      }
    ]
  },
  {
    version: '0.44.0',
    date: '2026-09-25',
    changes: [
      {
        icon: '👋',
        title: 'New to MightyMouse? Setup is ONE choice.',
        detail:
          'Pick your phone or your code and it walks you straight to your first win, with Back and Skip on every step. On a fresh Mac, your first voice press records right away.'
      },
      {
        icon: '🌐',
        title: 'A browser right beside your chat.',
        detail:
          'Links from a conversation open in tabs next to it, and you can bring your Chrome, Brave, Edge or Arc sign-ins and passkeys along. Drop in a file and it fills the form on the page for you.'
      },
      {
        icon: '📁',
        title: 'See everything your agents MADE.',
        detail:
          'The Made tab lists every page, file and app your agents built, grouped by project. Start or stop a local app in one click and star the ones you keep coming back to.'
      }
    ]
  },
  {
    version: '0.43.0',
    date: '2026-09-24',
    changes: [
      {
        icon: '🧭',
        title: 'Everything lives in one sidebar.',
        detail:
          'Chat and Code share one sidebar on the left, and Settings opens right inside the same window instead of a separate one. Pin the chats and agents you come back to, and tuck finished ones away with Archive.'
      },
      {
        icon: '🧠',
        title: 'Pick your model right where you type.',
        detail:
          'The model menu sits next to the message box in Chat and Code, and you can search it. Choose which model a new agent starts on and it remembers next time.'
      },
      {
        icon: '💬',
        title: 'Your agents work right inside MightyMouse.',
        detail:
          'Start a coding agent and it opens right here in the app, not in a separate window. Paste a screenshot straight into the thread, press Stop on your Mac or phone to interrupt it mid-task, and pick an ended session back up with Continue.'
      },
      {
        icon: '🌐',
        title: 'Chat from ANY browser.',
        detail:
          'Sign in at app.getmightymouse.com to chat with the top AI models from any computer, nothing to install. Drag in an image or a file and ask about it.'
      },
      {
        icon: '🎙',
        title: 'Your words come out cleaner.',
        detail:
          'Um, uh and other filler words are dropped before your text is pasted. If the app closes in the middle of a recording, your words are saved and turned into text the next time you open it.'
      },
      {
        icon: '🖱️',
        title: "Make your Mac's pointer BIG from your phone.",
        detail:
          "Change the pointer's size and style from your phone's settings and watch it change on the Mac as you slide. Your phone also opens straight onto your controls, even when the Mac is out of reach."
      }
    ]
  },
  {
    version: '0.42.0',
    date: '2026-09-21',
    changes: [
      {
        icon: '💬',
        title: 'See every agent you have running, in one place.',
        detail:
          'Your coding agents show up as a list you can scan: what each one is working on, which need you, and which are quiet. Open any of them to read the whole conversation and type straight back.'
      },
      {
        icon: '📁',
        title: 'Point a chat at a folder and it works there.',
        detail:
          'Make a project from any folder on your Mac and its chats run inside it. Agents working in that folder file themselves under it, so you stop hunting for which window was which.'
      },
      {
        icon: '🔍',
        title: 'One shortcut finds anything you have.',
        detail:
          'Press Cmd+Opt+Shift+K and type. Your projects, chats, agents and settings all come up as rows you can open, so nothing is more than a few letters away.'
      },
      {
        icon: '🎙',
        title: 'Dictation is much FASTER.',
        detail:
          '25 languages now use a quicker engine that stays warm and ready, so your words land almost as fast as you say them. Everything else keeps working exactly as before.'
      },
      {
        icon: '⚡',
        title: 'You stay IN CONTROL of a running task.',
        detail:
          'When your Mac is doing something for you, Pause holds it before the next click and Try again repeats the last request. You can stop it whenever you want.'
      }
    ]
  },
  {
    version: '0.41.0',
    date: '2026-09-11',
    changes: [
      {
        icon: '💬',
        title: 'Talk to your agent on a full screen.',
        detail:
          'Open a conversation on your phone and it fills the screen, the way a chat app does. Your replies stay in the thread, so you can scroll back and read the whole exchange later.'
      },
      {
        icon: '⏳',
        title: 'See when it is working on your answer.',
        detail:
          'After you send something, a bubble with typing dots shows up until the reply lands. No more wondering whether your message went through.'
      },
      {
        icon: '📸',
        title: 'Send a photo with your question.',
        detail:
          'Attach a picture straight from the reply box. Useful when it is easier to show the thing than to describe it.'
      },
      {
        icon: '🎙',
        title: 'Speak your reply instead of typing it.',
        detail:
          'The mic is on the full screen now, along with opening the Mac and watching its screen, so you can do all of it without backing out to the list. Tap the title to see which agent you are talking to.'
      }
    ]
  },
  {
    version: '0.40.7',
    date: '2026-09-11',
    changes: [
      {
        icon: '🪟',
        title: 'Windows updates find you again.',
        detail:
          'The Windows installer now lives at a lasting link, and the updater feed ships with every release, so downloads and in-app updates stop hitting a missing page.'
      },
      {
        icon: '🍎',
        title: 'The Mac download link stops moving.',
        detail:
          'Getting MightyMouse onto a new Mac uses a stable bootstrap download that does not change every cut, so the page you bookmarked keeps working.'
      }
    ]
  },
  {
    version: '0.40.6',
    date: '2026-09-09',
    changes: [
      {
        icon: '🚀',
        title: 'Performance and bug fixes.',
        detail:
          'Phone Remote got a fix for staying connected to your Mac over long absences. Nothing to do on your side.'
      }
    ]
  },
  {
    version: '0.40.5',
    date: '2026-09-08',
    changes: [
      {
        icon: '📱',
        title: 'Your Mac stays unlocked while your phone drives it.',
        detail:
          'When the Mac was busy, a keypress your phone sent could arrive late enough that the Mac mistook it for someone walking up, and locked itself — leaving you with a phone that could no longer do anything. It now recognises its own input even when it arrives late, so you keep control. Someone actually sitting down at your Mac still locks it, exactly as before.'
      }
    ]
  },
  {
    version: '0.40.4',
    date: '2026-09-08',
    changes: [
      {
        icon: '🎙️',
        title: 'Voice setup tells you what is missing.',
        detail:
          'The setup row used to say Ready whenever the engine was on disk, even with your microphone switched off, so people re-downloaded a 148MB engine they already had and still could not transcribe. It now says Ready once you turn on the microphone and hands you a Turn on microphone button that goes straight to the ONE thing in the way.'
      },
      {
        icon: '🔌',
        title: 'Closing setup now actually closes it.',
        detail:
          'Closing the setup window used to bring it straight back a second later, so there was no way past it except quitting. Close it and it STAYS closed, and the app carries on without it.'
      }
    ]
  },
  {
    version: '0.40.3',
    date: '2026-09-06',
    changes: [
      {
        icon: '🚀',
        title: 'Performance and bug fixes.',
        detail:
          'Voice transcription and phone pairing both got fixes. Nothing to do on your side.'
      }
    ]
  },
  {
    version: '0.40.2',
    date: '2026-09-03',
    changes: [
      {
        icon: '🚀',
        title: 'Bug fixes and improvements.',
        detail: 'Setup, the walkthrough and the panel all got small fixes. Nothing to do on your side.'
      }
    ]
  },
  {
    version: '0.40.1',
    date: '2026-09-03',
    changes: [
      {
        icon: '🚀',
        title: 'Small fixes under the hood.',
        detail: 'This one is a maintenance update. Nothing to do on your side.'
      }
    ]
  },
  {
    version: '0.40.0',
    date: '2026-09-02',
    changes: [
      {
        icon: '🎙️',
        title: 'Set up voice and recording in one tap.',
        detail:
          'Recording and dictation now fetch what they need themselves, straight from Settings, so nothing has to be installed by hand first. The bar tells you it is Downloading and how far along it is, and a download that drops says so instead of going quiet.'
      },
      {
        icon: '🔴',
        title: 'Turn your phone into one big record button.',
        detail:
          'Switch on Big record button in Settings and a large red mic sits in the middle of the pad, for when your phone is lying on the desk rather than in your hand. Tap it to talk, tap again to send. The pad keeps working underneath it.'
      },
      {
        icon: '⚡',
        title: 'Listen opens the instant you tap.',
        detail:
          'Tapping listen paints instantly instead of after a beat, and the mic itself is ready in about a fifth of the time it took. Stopping and immediately starting again now works, where the second tap used to be swallowed.'
      },
      {
        icon: '🚀',
        title: 'Closing the setup window means closing it.',
        detail:
          'It used to come straight back, over and over, with no way out but finishing. Skip it and finish later from the menu bar whenever you want. Brand new accounts also stop being told their balance is zero while their free credits are still landing.'
      },
      {
        icon: '⌨️',
        title: 'The tour teaches one key, not four.',
        detail:
          'Talking to your Mac only needs a tap on fn, so that is what the walkthrough now shows you, instead of a four-key combination you never had to learn.'
      }
    ]
  },
  {
    version: '0.39.0',
    date: '2026-08-23',
    changes: [
      {
        icon: '🗣️',
        title: 'Talk to your Mac, and watch it act.',
        detail:
          "Voice mode is a small circle that stays out of your way until you need it, startable right from the tray. Ask it to do something and it can click and type on your Mac itself, with a full-screen view showing every step it takes and a real stop button that actually stops it."
      },
      {
        icon: '🔔',
        title: 'Choose how your Mac tells you things.',
        detail:
          "New switches in Settings let you pick whether updates from your agents show up as Mac notifications or MightyMouse cards, and your phone's Do Not Disturb no longer mutes the mirror."
      },
      {
        icon: '📊',
        title: 'See how far along your agent is, everywhere.',
        detail:
          'A progress ring now shows on every session card, list, and the swipe deck, with a full bar on the detail view. It reaches every screen it should, and the janky linear bar is gone for good.'
      },
      {
        icon: '📷',
        title: 'Your agent can find a photo without you sending one.',
        detail:
          'Turn on photo access in Settings and an agent can search and pull the picture it needs from your library itself, tap-free. Screenshots from your agent also arrive already circled and annotated where it matters.'
      }
    ]
  },
  {
    version: '0.38.0',
    date: '2026-08-20',
    changes: [
      {
        icon: '🎙️',
        title: 'Dictate in 100 languages.',
        detail:
          "Pick your language in Settings and speak Spanish, Hebrew, Japanese or 97 more. It tells you the download size before it starts, and if you speak a language it can't handle yet it SAYS so instead of pasting nonsense."
      },
      {
        icon: '🖱️',
        title: 'The next card comes into focus.',
        detail:
          'Dragging feels smooth and physical now, and the card behind sharpens as it arrives. The jump list also opens where it should instead of hiding under the screen.'
      },
      {
        icon: '💬',
        title: "Fullscreen the agent you're reading.",
        detail:
          "One tap blows an agent up to fill the whole window, even when it is not the one you are looking at. The button fills in while it is zoomed, so you can always tell."
      },
      {
        icon: '🔌',
        title: 'Your agents wear their own faces.',
        detail:
          "A notification from Claude Code, Cursor or cmux now arrives wearing that app's icon, so you know who is asking BEFORE you open it."
      },
      {
        icon: '⌨️',
        title: 'The bar fits what you put in it.',
        detail:
          'It grows and shrinks to match your text instead of sitting at one fixed width, long titles stop shoving the gear off the edge, and every button lights up when you touch it.'
      },
      {
        icon: '⚡',
        title: 'Minimize the panel and keep your place.',
        detail:
          'The panel tucks down to the Dock instead of blinking out, and your conversation is still there when you bring it back.'
      }
    ]
  },
  {
    version: '0.37.0',
    date: '2026-08-18',
    changes: [
      {
        icon: '✂️',
        title: 'Your clipboard stays yours.',
        detail:
          "Copying text out of some apps could hand you a jumble of internal letters and numbers on your next paste, with whatever you actually copied gone. Copying now reads straight from what's already on your clipboard, so NOTHING of yours gets overwritten."
      },
      {
        icon: '🔍',
        title: 'The mirror stays sharp when your phone joins.',
        detail:
          "Picking up your phone used to drop the mirrored screen to a blurry, stuttering picture, and it could freeze on the last frame. It now holds FULL quality the whole time, and the zoom ring keeps tracking your screen instead of drifting off."
      },
      {
        icon: '🕐',
        title: 'The blacked-out screen now tells you the time.',
        detail:
          "Cover your screen while you step away and a big CLOCK sits under the logo. A glance from across the room tells you the time, without touching anything."
      }
    ]
  },
  {
    version: '0.36.0',
    date: '2026-08-17',
    changes: [
      {
        icon: '🤖',
        title: 'Know which agent is actually working.',
        detail:
          "A session that's thinking says so, and one that's waiting on you shows how long it has been ignored. Each row now tells you when it really started, instead of resetting its clock every time the app restarts. Cards carry a short recap so you can tell them apart at a glance."
      },
      {
        icon: '📋',
        title: 'Paste to your Mac without raising a keyboard.',
        detail:
          "Move a link or a snippet from your Mac into whatever's in front of you with one button, sitting right on the deck. Before this you had to open a keyboard just to press it and close it again."
      },
      {
        icon: '🔌',
        title: 'Your phone stays paired through a dropped connection.',
        detail:
          "A brief network blip used to make your phone forget it was paired, so you'd scan the QR code again. It now tells a real unpair apart from a hiccup and reconnects on its own."
      }
    ]
  },
  {
    version: '0.35.0',
    date: '2026-08-16',
    changes: [
      {
        icon: '✨',
        title: 'Fix your writing where you wrote it.',
        detail:
          'Highlight text anywhere and a small bar appears over it. Fix, shorten or improve it in one click, and the result lands straight back in your document. Turn on FAST and the rewrite comes back in under half a second.'
      },
      {
        icon: '🗂️',
        title: 'Answer your agents one at a time.',
        detail:
          'The card deck your phone had is now on the Mac. Go through everything waiting on you one card per screen, and send an answer without hunting for the right window.'
      },
      {
        icon: '🪟',
        title: 'Tile your Mac windows from your phone.',
        detail:
          'Hold Settings for a second and pick a layout. Two apps side by side, stacked, or one app filling half the screen. Restore puts everything back where it was.'
      }
    ]
  },
  {
    version: '0.34.0',
    date: '2026-08-15',
    changes: [
      {
        icon: '🤖',
        title: 'See everything you have running, and talk to it.',
        detail:
          "Each one gets its own face and its own row, so you can tell at a glance who is doing what. Tap one to jump straight to where it is working, or send it a note mid-task even when it isn't waiting on you."
      },
      {
        icon: '🔔',
        title: 'Decide WHICH questions are worth a buzz.',
        detail:
          'Mute the kinds you do not care about, or set it to problems only. Everything still shows up in the app either way, so nothing gets lost.'
      }
    ]
  },
  {
    version: '0.33.0',
    date: '2026-08-14',
    changes: [
      {
        icon: '🤖',
        title: 'Your coding agent can reach you anywhere.',
        detail:
          'Leave Claude Code or Codex running and walk away. When it needs a yes or a no, your phone buzzes with the question - answer from the couch and it keeps going without you.'
      },
      {
        icon: '📥',
        title: 'Everything your agents asked, in one place.',
        detail:
          'A list of every question waiting on you, who asked it, and how long it has been sitting there. Clear one you do not want to answer, and take it back if you cleared it by mistake.'
      },
      {
        icon: '🖼',
        title: 'Your agent can show you a picture.',
        detail:
          'When it wants you to look at something rather than read about it, the picture lands on your phone and on your Mac.'
      }
    ]
  },
  {
    version: '0.32.0',
    date: '2026-08-12',
    changes: [
      {
        icon: '🔍',
        title: "Spin the ring's edge to zoom.",
        detail:
          "When your Mac's picture is on another screen, the outer edge of the app ring becomes a zoom knob. Slide your thumb around it to push in on what you're looking at, and back out again."
      }
    ]
  },
  {
    version: '0.31.0',
    date: '2026-08-09',
    changes: [
      {
        icon: '🔒',
        title: "Your Mac stops going dark while you're typing.",
        detail:
          "The privacy screen used to drop over you mid-sentence if you'd been working a while. Now it only covers up when you've actually stepped away."
      },
      {
        icon: '📱',
        title: 'Your Mac keeps playing when you switch apps.',
        detail:
          'Answer a text, check a map, and a little window keeps your Mac live in the corner — with sound.'
      },
      {
        icon: '🎙',
        title: 'Talk to your Mac with your phone in your pocket.',
        detail:
          "Your voice and your screen keep running when the app isn't the thing you're looking at."
      }
    ]
  },
  {
    version: '0.30.0',
    date: '2026-08-08',
    changes: [
      {
        icon: '🔒',
        title: 'Step away and your Mac stays yours.',
        detail:
          'Your screen goes black for the room while your phone keeps the live picture, and it stays that way as long as you need. Come back whenever you like and pick up right where you left off.'
      },
      {
        icon: '📱',
        title: 'Your phone keeps you posted.',
        detail:
          "It tells you the moment your Mac's screen goes black, so you always know the room can't see it."
      }
    ]
  },
  {
    version: '0.29.0',
    date: '2026-08-07',
    changes: [
      {
        icon: '🖱️',
        title: 'Scroll a long page with ONE thumb.',
        detail:
          'Draw a line down the edge of the pad and a little scroll strip appears. Hold your thumb near either end and it keeps going, so a long document is one thumb instead of forty swipes.'
      },
      {
        icon: '🖱️',
        title: 'Three fingers up opens Mission Control.',
        detail:
          "The same swipe you use on your Mac's trackpad now works from your phone. Swipe back down to close it."
      },
      {
        icon: '🔍',
        title: 'Switching apps no longer flashes "connecting".',
        detail:
          'The screen on your phone used to blink an overlay every time you changed apps on the Mac. It now rides straight through.'
      }
    ]
  },
  {
    version: '0.28.0-broadcast',
    date: '2026-08-07',
    changes: [
      {
        icon: '🎧',
        title: 'Talk to ChatGPT through your phone.',
        detail:
          "Your iPhone becomes the Mac's mic and speaker, so you can hold a voice conversation from across the room. No echo."
      },
      {
        icon: '⚡',
        title: 'Quick app switcher.',
        detail:
          'Draw a circle on the pad and your apps arc out under your thumb. Settle on one to switch.'
      },
      {
        icon: '🔒',
        title: 'Lock your Mac, keep using it from your phone.',
        detail: 'The screen goes black to the room. Your phone still sees it and still drives it.'
      }
    ]
  },
  {
    version: '0.28.0',
    date: '2026-08-07',
    changes: [
      {
        icon: '🔍',
        title: 'Mirroring holds up when your phone drops off.',
        detail:
          'Disconnecting mid-mirror is clean now, so you can put the phone down and pick it back up whenever.'
      },
      {
        icon: '🔒',
        title: "A privacy curtain that's genuinely nice to look at.",
        detail: 'Slow light drifts in wide swells across the covered screen.'
      },
      {
        icon: '⚡',
        title: 'A smoother update flow.',
        detail:
          "New versions download quietly in the background, tell you when they're ready, and finish on quit."
      }
    ]
  },
  {
    version: '0.27.0',
    date: '2026-08-06',
    changes: [
      {
        icon: '🎙️',
        title: 'Get a transcript again, and get all of it.',
        detail:
          'Before, anything longer than a sentence came back cut down to its last few words - a 16-second clip could land as the single word "and". Now you get the whole thing, and any recording you already made can be fixed: open it and hit Re-transcribe.'
      },
      {
        icon: '🔌',
        title: 'Setting up is one screen now.',
        detail:
          'Pick your AI and grant permissions on a single page instead of stepping through four. Finishing it used to close onto an empty screen - app running, nothing but a menu bar icon. It now hands you straight to the panel, and closing setup early brings it back instead of stranding you.'
      },
      {
        icon: '⚡',
        title: 'Fixes and polish.',
        detail:
          "The cancel hint now shows while you're recording hands-free, re-transcribing can't strand a spinner on the wrong recording, and re-granting a permission lands somewhere real instead of nowhere."
      }
    ]
  },
  {
    version: '0.26.0',
    date: '2026-08-05',
    changes: [
      {
        icon: '🔒',
        title: "Protect your Mac's screen while you use your phone.",
        detail:
          "Turn it on and this Mac's screen goes black once you stop touching it, so you can work from your phone in a room full of people. Your phone keeps showing the live screen, and touching the Mac brings it back and locks it behind you."
      },
      {
        icon: '🔍',
        title: 'The mirrored screen recovers itself when it freezes.',
        detail:
          "If your Mac's display went to sleep the picture used to stick on the last frame with no sign anything was wrong. Now it reconnects on its own and tells you it's reconnecting, instead of leaving you on a stale screen."
      },
      {
        icon: '💬',
        title: 'A reply cut short by a quit no longer hangs.',
        detail:
          'If the app closed mid-reply, that conversation used to sit thinking for good. It now comes back saying the answer stopped and that asking again is safe.'
      },
      {
        icon: '🎨',
        title: 'Buttons stop hiding behind the keyboard strip.',
        detail:
          'The mic, app grid and gear stay tappable when the Mac-keys strip overlaps them, and the app switcher no longer paints behind it.'
      }
    ]
  },
  {
    version: '0.25.0',
    date: '2026-08-04',
    changes: [
      {
        icon: '📱',
        title: 'Your iPhone now has widgets.',
        detail:
          "Add Ask Mighty and Record to your Home Screen, Lock Screen or Control Centre and start either one with a single tap. A status widget shows your Mac's battery, name and whether it is still in reach."
      },
      {
        icon: '🎙️',
        title: 'Record now, send when your Mac is back.',
        detail:
          'Tapping Record starts a real recording even from a cold launch, and a clip you take out of range waits on your phone and delivers itself once you reconnect.'
      },
      {
        icon: '🔌',
        title: 'A clear way back when your Mac cannot be found.',
        detail:
          'The waiting screen now tells you what went wrong and gives you Try Again, plus a way to email yourself the Mac download. Scanning the QR uses the same six digits shown on your Mac, backing out no longer restarts the search, and pairing over Safari no longer fails after your Mac has already said yes. When your Mac is unreachable through the tunnel you land back on that screen instead of a dead error page.'
      },
      {
        icon: '💬',
        title: 'Every chat can use its own AI.',
        detail:
          'Pin one conversation to Claude and another to a local model instead of flipping one setting for all of them. Two chats open side by side also keep their answers to themselves, and a pane switched to another chat no longer lands your next message in the wrong one.'
      },
      {
        icon: '🧠',
        title: 'Run the AI on your own Mac, in one click.',
        detail:
          'Settings sets up Ollama or Rapid-MLX for you with a progress bar, and skips models that cannot actually hold a conversation. When something fails you now get the real reason - signed out, or out of credit - instead of an error code.'
      },
      {
        icon: '🗣️',
        title: 'Follow along as your Mac reads to you.',
        detail: 'Each word lights up in the reply as it is spoken.'
      }
    ]
  },
  // Broadcast-only entry, not a shipped version. The in-app "What's new" screen
  // reads the per-version entries below; this one exists so a win-back email can
  // span 0.21-0.24 without those entries claiming features they didn't ship.
  // Mail it with: bin/mm-release-email --version 0.24.0-broadcast
  {
    version: '0.24.0-broadcast',
    date: '2026-08-03',
    changes: [
      {
        icon: '🎙️',
        title: 'Talk without holding anything down.',
        detail:
          'Double-tap the listen hotkey on your Mac, or long-press the mic on your phone, and just keep talking. Every time you pause, what you said lands at your cursor. It listens on your own machine, so nothing is uploaded and it works with no connection at all.'
      },
      {
        icon: '🎧',
        title: 'Your iPhone is now a Mac microphone.',
        detail:
          'Pick MightyMouse as the input in any app and talk through your phone instead of leaning into your laptop. One password prompt the first time, then a live meter shows it is actually hearing you. Voice assistants no longer hear their own echo, so you can talk to them hands-free.'
      },
      {
        icon: '⚡',
        title: 'Draw a circle to switch apps.',
        detail:
          'Trace a ring on the pad and your open apps arc out under your thumb. Icons swell as you get near them, and settling on one switches to it. Hold at the base to dismiss.'
      },
      {
        icon: '📷',
        title: 'Point your camera at the code to pair, from anywhere.',
        detail:
          'Scanning the QR pairs you outright now, instead of asking for a code it already had. The remote also stopped needing both devices on the same Wi-Fi. Once you are signed in it reaches your Mac from any network.'
      }
    ]
  },
  {
    version: '0.24.0',
    date: '2026-08-03',
    changes: [
      {
        icon: '🎙️',
        title: 'Talk without holding anything.',
        detail:
          'Double-tap the listen hotkey on your Mac, or long-press the mic on your phone, then just keep talking. Every time you pause, what you said lands at your cursor. It listens on your machine, so nothing is uploaded and it works with no connection.'
      },
      {
        icon: '🎨',
        title: 'Every recording shows its own sound.',
        detail:
          'Your library now draws the waveform of each clip right in the row, tinted so a dictation and a screen recording read apart at a glance.'
      },
      {
        icon: '💬',
        title: 'See what the answer is actually doing.',
        detail:
          'A request used to sit on a frozen "Running…" for its whole length, which looks identical to a hang. Your phone now shows the step it\'s on, with a pulsing dot so you can tell working from finished.'
      },
      {
        icon: '⌨️',
        title: 'The pad stops fighting the bar above it.',
        detail:
          'The app row and floating bar reposition cleanly as the keyboard opens and closes, and the app list stays in the order you expect.'
      }
    ]
  },
  {
    version: '0.23.0',
    date: '2026-08-02',
    changes: [
      {
        icon: '🎙️',
        title: "Use your iPhone as your Mac's microphone.",
        detail:
          "Pick MightyMouse as the input in any app and talk through your phone instead of leaning into your laptop. Setup is one password prompt the first time you open it, and a live meter beside the badge shows it's actually hearing you."
      },
      {
        icon: '🔊',
        title: 'Talk to voice assistants without the echo.',
        detail:
          "Voice mode used to feed the assistant its own voice back through your phone's speaker, so it talked over itself. The Mac's audio now steps aside while your mic is live, and you can still hear the Mac while dictating."
      },
      {
        icon: '🔌',
        title: 'Pairing asks one thing at a time, camera first.',
        detail:
          "Point the camera at the code and you're in - no second screen asking what you just tapped, no card demanding an address and a code at once. Scanning works more than once, Connect always has a way back, and a phone that can't find your Mac says which of the three reasons it hit."
      },
      {
        icon: '🔍',
        title: 'Put the mirrored screen where you want it.',
        detail:
          'The screen was stuck above the pad. Now it sits above, below, or inline, and the zoom bar has a proper anchor inside the pad.'
      },
      {
        icon: '🛟',
        title: 'A crashed window offers a way out.',
        detail:
          'A render error used to paint a blank window you could only escape by quitting. Every window now shows recovery UI with a Try again button.'
      }
    ]
  },
  {
    version: '0.22.0',
    date: '2026-08-01',
    changes: [
      {
        icon: '⚡',
        title: 'Draw a circle to switch apps.',
        detail:
          'Trace a ring on the pad and your open apps arc out under your thumb. Icons swell as you near them, and settling on one switches to it. Hold at the base to dismiss.'
      },
      {
        icon: '🔌',
        title: 'Your phone works away from home.',
        detail:
          "The remote used to need both devices on the same Wi-Fi. Once you're signed in it reaches your Mac from anywhere, and when it can't, the Mac now tells you why instead of failing silently."
      },
      {
        icon: '📷',
        title: 'Point your camera at the code to pair.',
        detail:
          'Scanning the QR now pairs you outright, instead of asking for a code it already had. The Mac also greets a phone the moment it pairs, rather than sitting there looking idle.'
      },
      {
        icon: '🔊',
        title: "Hold the mute badge for the Mac's volume.",
        detail:
          "Press and hold the audio badge to slide your Mac's own volume from the couch. A plain tap used to warp the cursor and restart the audio twice while looking like it did nothing."
      },
      {
        icon: '🔌',
        title: 'End a session without unpairing.',
        detail:
          "Disconnecting and forgetting a device are two different things now, so stepping away doesn't cost you the pairing. You can also hang up from the phone itself and pick it straight back up."
      },
      {
        icon: '✨',
        title: 'Setup remembers where you were.',
        detail:
          "Granting Screen Recording restarts the app, and first run used to drop you back at step one. It now reopens exactly where you left off, and leads with what's free instead of a price."
      }
    ]
  },
  {
    version: '0.21.0',
    date: '2026-07-31',
    changes: [
      {
        icon: '🖱️',
        title: 'The app switcher floats on the deck.',
        detail:
          "Switch apps and tabs without leaving the pad. The bar stays the context switcher and nothing else, capped so it can't spill across your screen, and your profile chip no longer bleeds over its divider."
      },
      {
        icon: '⌨️',
        title: 'Phone Remote has its own menu bar section.',
        detail:
          'Pairing and settings sit at the top level of the menu instead of buried a level down. A phone you disconnect can also pair again straight away - it used to retry a credential you had already revoked, forever, with no way back.'
      },
      {
        icon: '🔒',
        title: 'Setup and your remote got a round of fixes.',
        detail:
          'A floating coach points at the exact row you need to drag MightyMouse into and follows you into System Settings, Screen Recording is optional, and granting a permission takes effect immediately instead of doing nothing. A deleted skin falls back to the default instead of leaving you blank, and stopping a mirror on purpose no longer reports itself as an error.'
      }
    ]
  },
  {
    version: '0.20.0',
    date: '2026-07-29',
    changes: [
      {
        icon: '💬',
        title: 'Continue picks up the real thread.',
        detail:
          'Every finished row in History opened a blank "New conversation" instead of the thread you clicked, and a finished row is the only kind you can realistically click. Continuing now takes you into the actual conversation in the full chat window.'
      },
      {
        icon: '🎙️',
        title: 'A voice note opens ready to send.',
        detail:
          'Continuing a listen row showed your transcript as a message waiting on a reply that was never coming, with an empty box underneath. The transcript now lands in the composer, so you can edit it and press Enter.'
      },
      {
        icon: '🕘',
        title: 'History opens newest-first, and stays that way.',
        detail:
          "One Continue click used to flip your whole history oldest-first for the rest of the session, pinning an ancient row to the top. The filter's ALL button also flips to NONE once everything is showing, so one button clears the list and one brings it back."
      }
    ]
  },
  {
    version: '0.19.0',
    date: '2026-07-28',
    changes: [
      {
        icon: '⚡',
        title: 'Performance improvements and fixes.',
        detail: 'Under-the-hood work on setup reliability, plus polish to the phone remote.'
      }
    ]
  },
  {
    version: '0.18.0',
    date: '2026-07-28',
    changes: [
      {
        icon: '💳',
        title: 'Your invite counts even if they click it late.',
        detail:
          'If someone made their account first and only opened your link afterwards, the referral was silently recorded as organic and paid nobody. It now credits you for up to 30 days after they sign up.'
      }
    ]
  },
  {
    version: '0.17.0',
    date: '2026-07-28',
    changes: [
      {
        icon: '🔌',
        title: 'Invite a friend, and watch it land.',
        detail:
          'Your invite code and a short getmightymouse.com link now live in the portal, so sharing is a copy away. You can see who joined and who has not opened it yet, and a shared link unfurls with a proper preview instead of a bare URL.'
      },
      {
        icon: '💳',
        title: 'Signup credits land once, and correctly.',
        detail:
          'Credits could be granted twice on one account, or quietly not at all. Now it is exactly once per sign-in, and your balance reflects what you actually earned.'
      },
      {
        icon: '⬇️',
        title: 'Windows visitors stop getting a Mac installer.',
        detail:
          'The download page reads the machine you are on and offers the right thing, instead of handing everyone a .dmg.'
      },
      {
        icon: '✨',
        title: 'Small fixes.',
        detail:
          "The app switcher no longer slides under the mic, Settings names the skin you're actually wearing, menu bar rows appear on sign-in without a restart, and declining a screen capture no longer looks like a crash."
      }
    ]
  },
  {
    version: '0.16.0',
    date: '2026-07-27',
    changes: [
      {
        icon: '🧠',
        title: 'MightyMouse thinks with Claude Opus 5.',
        detail:
          "The newest, sharpest Claude now powers every rewrite, answer, and action, whether you're on your own Claude or ours. If yours can't reach Opus 5 yet, MightyMouse quietly steps down a model instead of dropping the run."
      },
      {
        icon: '🔒',
        title: "See every phone you've paired, and kick just one.",
        detail:
          'Each device shows its name, when you last used it, and a live dot, with its own Disconnect - before, forgetting phones was all-or-nothing on a list you couldn\'t even see. A remote saved to your Home Screen now names itself properly instead of hiding as "Safari".'
      },
      {
        icon: '✉️',
        title: 'Invite a friend by email, straight from your phone.',
        detail:
          'Type their address next to the QR code and MightyMouse sends the invite. No copying a link into another app.'
      },
      {
        icon: '🖱️',
        title: 'The pad stays yours while a task runs.',
        detail:
          'The progress card used to swallow the whole pad for the minutes a job took - it is now a slim card up top, and any tap that misses it still moves your cursor. The app switcher lights up the app you are actually in, Return finally sends a Return, and swapping a skin repaints instantly instead of sliding into place a beat late.'
      },
      {
        icon: '💬',
        title: 'Questions stop doubling up and threads stop vanishing.',
        detail:
          'Asking in the panel painted your question twice for the whole run. Acting on a voice note from your phone opened a fresh session, so the note sat alone unanswered and its thread disappeared from the picker. Both fixed.'
      }
    ]
  },
  {
    version: '0.15.0',
    date: '2026-07-27',
    changes: [
      {
        icon: '🖱️',
        title: 'Every finger leaves a comet trail.',
        detail:
          'Each touch now draws its own fading trail, so you can see exactly what the pad picked up. The pad also no longer vanishes when you rotate the phone to landscape.'
      },
      {
        icon: '💬',
        title: 'The chat picker shows real conversations.',
        detail:
          'It was buried under hundreds of one-line voice notes - now it lists only threads where a conversation actually happened. Reopening a thread mid-answer shows it still thinking, instead of your question with a blank space under it.'
      },
      {
        icon: '🎙️',
        title: 'The mic recovers, and the timer stops when you do.',
        detail:
          'Dismissing the mic permission prompt once used to break it for the rest of the session - the button glowed but nothing recorded. The recording timer now stops the moment the mic closes, rather than counting through transcription and then jumping backwards.'
      }
    ]
  },
  {
    version: '0.14.0',
    date: '2026-07-26',
    changes: [
      {
        icon: '🖱️',
        title: 'Landscape gives each thumb its own controls.',
        detail:
          'Turn the phone sideways and the deck splits into two clusters, one per bottom corner, with the trackpad free in the middle. Before, all eight controls sat in one corner and half of them were out of thumb reach. Opt-in from the remote’s settings, so nothing moves until you turn it on.'
      },
      {
        icon: '🔍',
        title: 'Both thumbs get the same full deck.',
        detail:
          'The mirror layout deals every control twice, reflected, so either hand can reach anything and neither has to learn a different set of buttons.'
      },
      {
        icon: '🖱️',
        title: 'Precision stays precise at high sensitivity.',
        detail:
          'The slow end of the trackpad is now pinned to a fixed speed, so a careful nudge moves the same small amount whether you are at 5x or 20x. Before, turning sensitivity up dragged the slow end up with it and small targets became unhittable.'
      },
      {
        icon: '⚡',
        title: 'Sensitivity now goes up to 20x.',
        detail: 'Cross a big display in one swipe if you want the reach.'
      },
      {
        icon: '⚡',
        title: 'Zoom taps land twice as fast.',
        detail:
          'The zoom shortcut used to send its two keystrokes as two separate trips, which added about 100ms and left a window where only half of them arrived.'
      },
      {
        icon: '🎨',
        title: 'Sideways decks keep their skin colors.',
        detail:
          'Splitting the deck used to shuffle which button got which cap color, so landscape read like a different skin.'
      }
    ]
  },
  {
    version: '0.13.1',
    date: '2026-07-26',
    changes: [
      {
        icon: '🖱️',
        title: 'Stop a running task from your phone.',
        detail:
          "An Act run used to be unstoppable once it left your hand. There's now a stop button while it runs."
      },
      {
        icon: '💬',
        title: 'Cancel or retry a stuck transcription.',
        detail:
          'The transcribe pill could hang with no way out. It now cancels and retries, and the chat composer gets its own cancel too.'
      },
      {
        icon: '⌨️',
        title: 'Zoom a cmux pane from the keyboard bar.',
        detail: 'A tmux zoom button, right where your thumbs already are.'
      },
      {
        icon: '⌨️',
        title: 'The app chip is there the moment the keyboard opens.',
        detail:
          'Reopening the keyboard flashed an empty chip while it looked the app up again. It now remembers.'
      },
      {
        icon: '⌨️',
        title: 'The keyboard stops fighting you.',
        detail:
          'Scrolling the trackpad dismissed the keyboard, the swap button bounced its own taps, and a bar dropdown opened behind the keyboard instead of above it. All three are fixed.'
      }
    ]
  },
  {
    version: '0.13.0',
    date: '2026-07-26',
    changes: [
      {
        icon: '⌨️',
        title: "Reach the app you're typing into.",
        detail:
          "The bar above your phone's keyboard names the app in front of you, and for browsers it lists your tabs and profiles by name. Switch to the one you want instead of stepping blind through them."
      },
      {
        icon: '📋',
        title: 'Paste from your Mac, on your phone.',
        detail:
          "A paste key on both keyboard bars pulls whatever is on your Mac's clipboard. Images and files come through too, not only text."
      },
      {
        icon: '🔌',
        title: 'Re-pair without getting stranded first.',
        detail:
          "Pairing again used to be possible only after the connection had already broken. There's now a Re-pair button in the remote's Settings, so you can fix a flaky link before it drops you."
      },
      {
        icon: '⌨️',
        title: 'The keyboard bar stops fighting the keyboard.',
        detail:
          "Opening a dropdown in the bar dismissed the keyboard underneath it, and the bar sometimes hung around after the keyboard was gone. Both stop now, and the bar's chips finally line up on one baseline."
      },
      {
        icon: '💬',
        title: 'A failed run tells you what went wrong.',
        detail:
          "When an Act run fails you get the actual reason, whether you hit a limit, lost the connection, or the model refused, instead of a generic failure you can't do anything with."
      },
      {
        icon: '📶',
        title: 'Hitting a limit says so.',
        detail:
          'Running out of remote capacity reported itself as a network error, which sent you debugging your wifi for no reason. It now says you hit a limit.'
      }
    ]
  },
  {
    version: '0.12.0',
    date: '2026-07-25',
    changes: [
      {
        icon: '🔍',
        title: 'Your phone can be a second screen now.',
        detail:
          'Screen sharing gained a Mirror | Extend toggle. Extend makes a real second display for your Mac and puts it on your phone, so your monitor keeps showing your own work instead of a copy of it.'
      },
      {
        icon: '⌨️',
        title: 'Keys you press look pressed.',
        detail:
          "Tapping a key on the remote keyboard now flashes and buzzes the moment it lands, so you can tell it registered. Double-tap Shift or Command to latch it on for a run of shortcuts, tap again to drop it. Swap between your phone's keyboard and the Mac one from either board, no trip to Settings. Macs with a European keyboard get the right layout drawn."
      },
      {
        icon: '🖱️',
        title: 'Smoother cursor at slow speeds.',
        detail:
          'Fine positioning was moving in visible hops. The cursor now glides between points at the speeds where you notice it most.'
      },
      {
        icon: '📷',
        title: 'Pick a shape for your camera.',
        detail:
          'Tap the camera preview to switch between wide, tall, and circle. Flip now takes a double tap so it stops firing by accident.'
      }
    ]
  },
  {
    version: '0.11.1',
    date: '2026-07-25',
    changes: [
      {
        icon: '🔌',
        title: 'Quitting no longer strands your phone.',
        detail:
          'Command-Q now tucks MightyMouse into the menu bar instead of closing it, so the remote on your phone keeps working. To really quit, use Quit MightyMouse in the menu bar icon.'
      },
      {
        icon: '🔍',
        title: 'Lock the zoomed view onto your cursor.',
        detail:
          "Hold the zoom knob for a moment and the mirrored screen follows your Mac's cursor as it moves, instead of staying where you left it. Tap again to let go, and a small note tells you which way you just switched it."
      },
      {
        icon: '🎙️',
        title: 'Your voice notes keep their answers.',
        detail:
          'Dictated notes were saving the question but not the reply, so the conversation looked half finished. The answer now lands in the thread where you asked it.'
      },
      {
        icon: '💬',
        title: 'Threads stay in step across your Mac and phone.',
        detail:
          'Ask something on your Mac while the same thread is open on your phone and the reply now shows up there too, instead of the phone sitting frozen until you reopen it.'
      },
      {
        icon: '🎨',
        title: 'Two new looks for the remote.',
        detail:
          'Field Unit and Big Red join the skin store, and every skin now goes by a proper name instead of a build label.'
      }
    ]
  },
  {
    version: '0.11.0',
    date: '2026-07-24',
    changes: [
      {
        icon: '⌨️',
        title: 'Type on your Mac from your phone.',
        detail:
          'A real keyboard on the remote, laid out like the one on your Mac. Turn the phone sideways and it squashes to one side so you can thumb it one-handed. Shortcuts land properly too, so the Command key no longer stays stuck down after you send one.'
      },
      {
        icon: '💬',
        title: 'Ask the same question two ways at once.',
        detail:
          'A chat tab now holds up to six conversations side by side, each on whatever model you pick. They all answer at the same time, so you can see which one you like before you commit.'
      },
      {
        icon: '🎨',
        title: 'New remote looks, without updating the app.',
        detail:
          'Skins are real artwork now, and they arrive on their own. Tap the bottom corners of the deck to flip between your last two without opening settings.'
      },
      {
        icon: '🎙️',
        title: 'Your phone tells you what it is doing.',
        detail:
          'Hold the mic and the thread says "Transcribing…" instead of going blank. Act runs report each step as they happen, and the chat button takes you to your threads, not the last one you left open.'
      }
    ]
  },
  {
    version: '0.10.1',
    date: '2026-07-23',
    changes: [
      {
        icon: '🎯',
        title: 'The agent can point at things on your screen.',
        detail:
          'Ask Act to find something and it draws a highlight right on your screen where it is, instead of only describing it in words.'
      },
      {
        icon: '🔒',
        title: 'Text you paste can no longer boss your Mac around.',
        detail:
          'Anything MightyMouse reads for you - a page, a file, a selection - is now walled off from the instructions it follows. Hidden commands buried in that text get treated as text, not orders.'
      },
      {
        icon: '🎨',
        title: 'Phone Remote skins that are actual pictures.',
        detail:
          'Skins can now paint the deck, trackpad, and buttons with real artwork, not just colors. New looks arrive without updating the app.'
      },
      {
        icon: '⚡',
        title: 'Jump straight to any app from your phone.',
        detail:
          "Tap an app's icon in the switcher to go right to it. Tiles are bigger, easier to hit, and the selection is legible now."
      },
      {
        icon: '📮',
        title: 'Bug reports are simpler to send.',
        detail:
          'The report form no longer shows a wall of technical detail you did not need to read.'
      }
    ]
  },
  {
    version: '0.10.0',
    date: '2026-07-23',
    changes: [
      {
        icon: '🔌',
        title: 'Nothing installed? One button fixes it.',
        detail:
          'A new Setup screen finds what MightyMouse is missing and installs it for you. Nothing to type, nothing to paste, no developer tools to set up first. Every warning that used to be a sentence you could not act on is now a button that does the thing. Open it any time from the menu bar.'
      },
      {
        icon: '🎬',
        title: 'Recording works even without ffmpeg.',
        detail:
          'If your Mac does not have the tool MightyMouse records with, it fetches a signed copy in a few seconds and carries on. Intel and Apple Silicon both covered. Already have it? Nothing gets downloaded.'
      },
      {
        icon: '🎨',
        title: 'Dress up your Phone Remote.',
        detail:
          'A skin store with real preview cards, so you see the actual deck before you pick it. Military, Cap, Pro and Plain, and skins are now separate from layout, so any look works with any set of controls. Turn your phone sideways and the previews turn with it.'
      },
      {
        icon: '📱',
        title: 'Put the remote on your Home Screen.',
        detail:
          'The Phone Remote now shows you how to install it as a real app on iPhone and Android, so it opens full screen instead of inside a browser tab. Controls sit flush above the home bar on every layout and every skin.'
      },
      {
        icon: '🎙️',
        title: 'Talk to your Mac, then send it to work.',
        detail:
          'Hold the transcript on your phone to fire it as an Act run instead of just a message. Cancel and Stop are now part of the skin, not floating on top of it.'
      },
      {
        icon: '💳',
        title: 'Credit history you can read.',
        detail:
          'The web portal says what each charge was for in plain words, with a running balance and rows you can open for detail. Membership got a full redesign, and your download link now sits in the header.'
      },
      {
        icon: '💬',
        title: 'Follow-ups stay in one conversation.',
        detail:
          'Ask about a screenshot or recording, then ask again, and it stays a single thread instead of splitting in two. The panel also shows the app icon and site favicon for whatever it is looking at.'
      }
    ]
  },
  {
    version: '0.9.0',
    date: '2026-07-22',
    changes: [
      {
        icon: '🧭',
        title: 'A walkthrough that has you actually press the keys.',
        detail:
          'First run now ends with a short tour of what MightyMouse does. Each step asks you to press the real shortcut, and the real thing happens on your screen when you do. If a shortcut does not respond, it tells you right there instead of leaving you stuck. You can reopen it any time from the menu bar.'
      },
      {
        icon: '🔌',
        title: 'Pair your phone during setup.',
        detail:
          'The last step of the tour puts a QR code on screen. Scan it and your phone is already a trackpad and a mic before you have finished setting up.'
      },
      {
        icon: '⚙️',
        title: 'Settings you can read.',
        detail:
          'Every label and description got rewritten in plain words. Phone Remote moved to the top in its own block, and six preferences that were hidden for no good reason are now where you can reach them: sound effects, the capture HUD, auto-paste, feedback, the ambient context log, and run details.'
      },
      {
        icon: '📱',
        title: 'Phone Remote fits your screen properly.',
        detail:
          'Fixed the bottom row of controls sitting too high when you add the remote to your Home Screen. It now sits flush on every layout, not just Pro II.'
      }
    ]
  },
  {
    version: '0.8.2',
    date: '2026-07-22',
    changes: [
      {
        icon: '🎨',
        title: 'A remote that looks machined, not drawn.',
        detail:
          "The Pro layout is rebuilt on a real cork deck with a brushed steel body. Keycaps have sculpted walls and four-sided shoulders, the mic ball sits in a recessed socket, and the steel now bleeds edge to edge behind your phone's home bar instead of stopping short."
      },
      {
        icon: '⚙️',
        title: 'Settings you can actually find things in.',
        detail:
          "Phone Remote settings are grouped into collapsible sections that remember what you left open. Trackpad and Screen start expanded, tapping outside closes the sheet, and sliders use the MightyMouse accent instead of Safari's default blue."
      },
      {
        icon: '🖱️',
        title: 'A trackpad that catches the small stuff.',
        detail:
          'Tiny finger movements no longer get swallowed by a dead zone, so slow, precise cursor work lands where you expect.'
      },
      {
        icon: '✉️',
        title: 'Your invite link fills in their email.',
        detail:
          'When someone opens your referral link, the signup form already has their email in it, so there is one less thing for them to type.'
      },
      {
        icon: '💳',
        title: 'Referral credits now count once.',
        detail: 'Fixed a bug where a referral credit could be unwound twice.'
      }
    ]
  },
  {
    version: '0.8.1',
    date: '2026-07-21',
    changes: [
      {
        title: 'Chat with your Mac from your phone.',
        detail:
          'Tap the message icon on the Phone Remote and you are in the same conversations as the Mighty window on your Mac. Watch the work happen step by step as it reads files and runs commands, get a properly rendered answer back, and hold the mic to talk instead of type.'
      },
      {
        title: 'Hear your Mac, not just see it.',
        detail:
          "Screen mirroring now carries your Mac's audio to your phone, in sync with the picture. Flip it on and off from phone settings."
      },
      {
        title: 'Phone Remote controls you can feel.',
        detail:
          'The Pro controls are rebuilt as real keycaps on a machined deck. They have thickness, they bottom out when you press them, and long-pressing one no longer fires an accidental tap.'
      },
      {
        title: 'Stop a run without it looking broken.',
        detail:
          'Live Ask and Act cards now have a real stop button, and pressing it says "Stopped." instead of flashing a red error. Whatever the agent already wrote is kept.'
      },
      {
        title: 'A first run that asks one thing at a time.',
        detail:
          'Setup is now four short screens instead of one crowded page. Each permission gets its own step and moves on by itself once you grant it.'
      },
      {
        title: 'Invite a friend, both of you get credits.',
        detail:
          'Share your personal link from the app or straight off your phone by tapping the mouse mark. Anyone who signs up through it is credited to you.'
      }
    ]
  },
  {
    version: '0.8.0',
    date: '2026-07-20',
    changes: [
      {
        title: 'Phone Remote - run your Mac from your phone.',
        detail:
          "Scan a QR code and your iPhone becomes a trackpad, a mic, and a keyboard. Mirror your Mac's screen and touch it directly to move the cursor. Works on cellular, not just your own Wi-Fi, so you can drive your machine from the couch or across town."
      },
      {
        title: 'A Media Library, built into the composer.',
        detail:
          "Every recording and screenshot now lives in a Library tab right where you're working. Grab a past capture and drop it into a conversation without ever opening Finder."
      },
      {
        title: 'Agents that can run for an hour.',
        detail:
          "Long jobs no longer die quietly. Runs go up to an hour with a watchdog that notices when one stalls, and they show up in your history while they're still working, not only after they finish."
      }
    ]
  },
  {
    version: '0.7.5',
    date: '2026-07-17',
    changes: [
      {
        title: 'Mighty remembers your setup.',
        detail:
          'The chat window keeps its size, position, and sidebar width across launches, with a ⌘K palette and search that looks inside messages, not just titles.'
      },
      {
        title: 'See which brain answered.',
        detail:
          'Mighty names the model that actually ran, not just the backend, and can show per-turn timing live as the answer streams.'
      },
      {
        title: 'Custom instructions everywhere.',
        detail:
          'Set instructions once and they apply across rewrite, ask, act, and Mighty, with all four modes on by default.'
      },
      {
        title: 'Control the cursor with your hand.',
        detail: 'Gaze mode adds hand tracking, so a fist drags the cursor and a pinch clicks.'
      }
    ]
  },
  {
    version: '0.7.4',
    date: '2026-07-15',
    changes: [
      {
        title: 'Smart dictation, hold to talk.',
        detail:
          "Hold the hotkey instead of double-tapping to dictate, with a live progress glow and phase labels so you know exactly when it's listening."
      },
      {
        title: 'Smart dictation now screen-aware.',
        detail:
          "Dictation understands what's on your screen while you talk, for more accurate results."
      },
      {
        title: 'Faster replies.',
        detail:
          'MightyMouse starts warming up your session the moment you open the panel, so responses feel snappier.'
      },
      {
        title: 'Subscribe monthly or buy credits once.',
        detail:
          'Pick a monthly plan or a one-time credit pack right from Settings, both on desktop and in the web portal.'
      }
    ]
  },
  {
    version: '0.7.3',
    date: '2026-07-14',
    changes: [
      {
        title: 'Pick the brain for the job.',
        detail:
          'On the paid plan you can now choose which AI model answers, right from the conversation. Switch anytime.'
      },
      {
        title: 'One conversation, everywhere.',
        detail:
          'The panel and the bigger Mighty window now share the same live thread, so your chat follows you without missing a beat.'
      }
    ]
  },
  {
    version: '0.7.2',
    date: '2026-07-14',
    changes: [
      {
        title: 'Pick up right where you left off.',
        detail:
          'Expand an answer mid-stream and the full conversation carries over into Mighty, no restart.'
      },
      {
        title: 'Set up in seconds.',
        detail:
          "First launch walks you through picking your AI provider, so you're ready on the first try."
      },
      {
        title: 'Grab the Mac app from your inbox.',
        detail:
          "Request the download and we email you a clean link, with a smoother welcome once you're in."
      }
    ]
  },
  {
    version: '0.7.1',
    date: '2026-07-13',
    changes: [
      {
        title: 'See exactly what the AI did.',
        detail:
          'A new transcript inspector opens the full run in one click from the HUD, so you can see every step, tool call, and result.'
      },
      {
        title: 'Make your shortcuts yours.',
        detail:
          'A built-in emoji picker and real default icons make setting up custom shortcuts fast and fun.'
      },
      {
        title: 'Ask what you did, get a real answer.',
        detail:
          'The assistant can now read your own activity log to answer questions about your past work.'
      },
      {
        title: 'Your prompts stay yours.',
        detail: 'Prompt and output files are now hidden from Finder for extra privacy.'
      },
      {
        title: 'Emojis that actually show up.',
        detail:
          'Status icons like the skip and check marks now render everywhere instead of empty boxes.'
      }
    ]
  },
  {
    version: '0.7.0',
    date: '2026-07-13',
    changes: [
      {
        title: 'Meet Mighty.',
        detail:
          'Pop your chat out of the panel into a full window - switch models mid-conversation, use job templates, view markdown artifacts, and jump back to the panel anytime.'
      },
      {
        title: 'Run actions right on a capture.',
        detail:
          'Hover a finished screenshot or recording and fire off a Quick Action without leaving the card.'
      },
      {
        title: 'Leave yourself a note.',
        detail:
          "Jot a quick note on any screenshot, recording, or listen capture - it's remembered and shows up in your Media Library."
      },
      {
        title: 'See it as you capture it.',
        detail: "A live preview now shows right on the HUD card while you're capturing."
      },
      {
        title: 'Cleaner answers.',
        detail:
          'Assistant replies in the panel now render as proper formatted text instead of a wall of plain markdown.'
      },
      {
        title: 'Bring your own local model.',
        detail:
          'MightyMouse can now run against a local Ollama model instead of a cloud provider.'
      },
      {
        title: 'Something broken? Tell us in one click.',
        detail:
          'New "Report a Bug…" in the tray menu, plus a one-click prompt if the app ever crashes - opens a prefilled email with your version and the error.'
      }
    ]
  },
  {
    version: '0.6.0',
    date: '2026-06-14',
    changes: [
      {
        title: 'Draw right on your screen.',
        detail:
          'Hit ⌘⌥⇧D, scribble arrows or circles over anything on screen with a glowing ink trail, then hit it again to snap an annotated screenshot ready to Ask or Act on.'
      },
      {
        title: 'Attach files in Mighty Chat.',
        detail:
          'Your personal agent window now takes images, audio, and files. Drag them in or use the + button, just like the main panel.'
      },
      {
        title: 'Find any past run, fast.',
        detail:
          'History now filters by kind (Ask, Act, Listen, Recording, Screenshot…) and your captures show up the moment they finish, color-coded.'
      },
      {
        title: 'Jump straight to the files.',
        detail:
          'Every run in History has an open-folder button that takes you right to its prompts, outputs, and captures in Finder.'
      },
      {
        title: 'Your agent, by name.',
        detail:
          'Renamed your Mighty persona? The tray now says "Chat with <your name>…" instead of the default.'
      },
      {
        title: 'Quieter in the background.',
        detail:
          'Brief network blips no longer spam errors, and your saved login is always encrypted at rest.'
      }
    ]
  },
  {
    version: '0.5.0',
    date: '2026-06-07',
    changes: [
      {
        title: 'Meet Mighty, your standing AI agent.',
        detail:
          "A personal agent that chats with you, runs scheduled jobs, and remembers what it's working on."
      },
      {
        title: 'Answers you can actually look at.',
        detail: 'Mighty now builds rich HTML artifacts and opens them right inside the app.'
      },
      {
        title: 'Park an agent anywhere on screen.',
        detail: 'Drop a background task wherever you like and let it run while you keep working.'
      },
      {
        title: 'Your cursor can do the clicking.',
        detail:
          'Ask a question and let MightyMouse point, type, and click for you, straight from the answer.'
      },
      {
        title: 'Smarter chats about your stuff.',
        detail:
          'Media chat understands your files better with sharper search and image understanding.'
      },
      {
        title: "See how it's all going.",
        detail: 'Full usage and activity insights across every part of MightyMouse.'
      }
    ]
  },
  {
    version: '0.4.0',
    date: '2026-06-04',
    changes: [
      {
        title: 'Connect your accounts.',
        detail:
          'Link Gmail and more, then ask about your own stuff. OAuth opens in your real browser, no sketchy embedded login.'
      },
      {
        title: 'Your stuff, on your machine.',
        detail: 'A personal knowledge base built from your connected accounts, stored on-device.'
      },
      {
        title: 'A media library that gets it.',
        detail:
          'Browse your captures with a real player, waveform scrubber, and searchable frames.'
      },
      {
        title: 'Suggestions that read the room.',
        detail:
          'One-tap action chips, color-coded by mode, with pre-drafted writes. Hit it on demand with the suggestion hotkey.'
      },
      {
        title: 'A cleaner notch.',
        detail: 'The recording island is one slim bar now, with a steadier timer.'
      }
    ]
  },
  {
    version: '0.3.0',
    date: '2026-05-31',
    changes: [
      {
        title: 'Selection capture that just works.',
        detail:
          'Reads your highlighted text natively, no clipboard race. Falls back to clipboard in apps without support.'
      },
      {
        title: 'It remembers the context.',
        detail:
          'Recent activity and your past instructions and tone feed into prompts. Opt-in, respects the ambient-context toggle.'
      },
      {
        title: 'Edit your quick actions.',
        detail:
          'The pencil button on the chip row lets you add, edit, and delete chips (name, icon, body).'
      }
    ]
  },
  {
    version: '0.2.0',
    date: '2026-05-30',
    changes: [
      {
        title: 'Ambient Context Log (opt-in).',
        detail: 'Background app, window, URL, and typed-text logger with redaction.'
      },
      { title: 'Smarter model under the hood.', detail: 'LLM bumped to claude-opus-4-8.' }
    ]
  },
  {
    version: '0.1.0',
    date: '2026-05-29',
    changes: [
      {
        title: 'Hello, MightyMouse.',
        detail:
          'Rewrite and ask panel, ACT mode agentic runner, screen capture with Whisper transcription, cursor companion.'
      }
    ]
  }
]
