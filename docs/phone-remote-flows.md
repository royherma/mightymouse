# Phone Remote - what connects by itself, and what needs a scan

One page. Read the table, find your situation, done.

## The one rule

**Your phone holds a saved key. If it still has the key, it reconnects by itself. If the key is gone, you scan.**

That's it. Everything below is just "does it still have the key?"

The key is saved on the phone forever - it survives restarting the app, restarting the Mac, rebooting the phone, and changing Wi-Fi. Only three things delete it: you tap X on the Mac, you tap "Forget paired devices", or you delete the app.

## User stories

| # | What happens to you | What you see | Do you scan? |
|---|---|---|---|
| 1 | 🔁 **You restart the Mac app** | "Restarting…" then it comes back | ✅ **No** |
| 2 | 💤 **Mac goes to sleep, you wake it** | Reconnects when you pick the phone up | ✅ **No** |
| 3 | 📱 **You lock your phone and unlock it later** | Reconnects the moment you look at it | ✅ **No** |
| 4 | 🔄 **You reboot the phone** | Opens straight to the trackpad | ✅ **No** |
| 5 | 📶 **Wi-Fi drops for a few seconds** | "Can't reach your Mac", then it's back | ✅ **No** |
| 6 | 🏠 **You go home, Mac is at the office** | Works over the internet (tunnel) | ✅ **No** |
| 7 | 🛜 **You join a different Wi-Fi** | Takes a few seconds to find the Mac | ✅ **No** |
| 8 | 🔌 **Mac's IP address changes** | Finds it by name (`mightymouse.local`) | ✅ **No** |
| 9 | 🆕 **Brand-new phone, first time ever** | Pairing screen with a QR code | 📷 **Yes - scan** |
| 10 | ❌ **You tapped X on that phone in Mac Settings** | "Scan the QR code again" | 📷 **Yes - scan** |
| 11 | 🧹 **You tapped "Forget paired devices"** | Every phone lands on the pairing screen | 📷 **Yes - all of them** |
| 12 | 🗑️ **You deleted and reinstalled the app** | Pairing screen | 📷 **Yes - scan** |
| 13 | 👥 **Second phone connects while the first is idle** | First phone: "another device took over" | ✅ **No** - tap Reconnect |
| 14 | 🖐️ **Second phone tries while you're actively using the first** | Second phone: "your Mac is busy" | ✅ **No** - wait 20s, tap Retry |
| 15 | 📲 **App installed to your home screen (PWA), Mac moved networks** | "Enter the 6-digit code" | 🔢 **Type the code** - see below |

## The three ways in

Only three, and you almost never see the last two.

| | When | How |
|---|---|---|
| 🔑 **Saved key** | Every normal day | Automatic. You do nothing. |
| 📷 **QR scan** | First time, or after you unpair | Mac Settings shows a QR → point your camera at it |
| 🔢 **6-digit code** | Only from a home-screen app that got lost | Mac Settings shows the code → type it into the phone |

**Why the 6-digit code exists:** when you install MightyMouse to your home screen, iOS gives it a private box that a QR scan can't reach - the camera always opens Safari, never your installed app. So the code is the way in. It expires after **5 minutes**; get a fresh one from the Mac if it times out.

## How the phone finds your Mac

It tries these in order, and stops at the first that answers. All automatic - this is why story 7 and 8 need no scan.

1. 📍 Where it already is
2. 🌍 The internet tunnel (works anywhere)
3. 🏷️ By name - `mightymouse.local`
4. 📓 The last address that worked
5. 🔍 A quick sweep of your home network
6. 🛑 Gives up → shows "scan again"

## If it says "can't reach your Mac"

That's a **network** message, not a pairing one. Your key is fine.

- Is the Mac awake, and is MightyMouse running?
- Is Phone Remote toggled on in Settings?
- Wait ~10 seconds - it retries on its own, backing off each time.
- **Don't scan the QR.** Scanning fixes nothing here and just adds a duplicate device row on the Mac.
