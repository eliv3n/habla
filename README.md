# Habla: Spanish in 30 minutes a day

A 12-week course for **listening and speaking only**. It runs on this computer, in your browser. There is nothing to install and nothing to pay.

## Start

1. Double-click **`Start Habla.cmd`** in this folder.
   A small window opens minimized (the local server) and Microsoft Edge opens the app.
2. Choose your name. Click **I am ready**, then **Start today's session**.
3. When you finish, close the Edge tab and the minimized "Habla server" window.

Use **Microsoft Edge**. It has natural-sounding Spanish voices (Mexico, Spain, Colombia and more). Chrome also works, but its Spanish voices sound robotic. You need to be online, because the voices come from the internet.

The first time you press **Speak**, Edge asks to use your microphone. Allow it if you want the app to check your answers. The microphone check is optional: the course works without it.

## Who is learning

The app starts with the question **Who is learning?** Each person chooses their name and gets their own progress: their place in the course, their review schedule and their settings.

- There are no passwords. Choosing a name is not a login. It only opens that person's progress.
- The name of the person who is learning is shown at the top right. Click it to change who is learning.
- A new tab asks again, and so does a new day. This way nobody practices under another person's name by mistake.
- Progress is kept on the device where the person practices. On devices that are connected with the family link, it also follows the person from device to device (see the next section).
- The names are in `data/profiles.js`. To add a person, add a line there.

## Progress on every device

Progress can follow each person from one device to another: start a lesson on the phone, continue on the computer.

- **Connect a device:** open the family link on it once, in the browser you use for Habla. The link is in the file `family-link.txt` in this folder. A connected device also shows it under **Settings → Other devices → Copy the family link**.
- **This computer:** the copy in this folder reads `family-link.txt` and connects by itself.
- **What is shared:** finished days, the review schedule, the notes, and the place in an unfinished session. Settings are not shared, because voices and the microphone belong to the device.
- **Nothing is lost when two devices disagree:** their progress is added together. Only **Start over from day 1** and **Load a backup file** replace the progress on every connected device.
- **Without internet** a device keeps working and sends its progress later.
- **Keep the link inside the family.** Anybody who has it can see and change the progress of the family. There is still no password and no account.

How it works: every device keeps its own full copy. A sealed (encrypted) copy is also kept on five public relays of the open Nostr network. Relays are simple servers that need no account. Only a device with the family link can read or change the sealed copy. The relays are free and run by other people, with no promise that they stay. If one stops, the others carry on. The list is in `data/sync.js`, and this command tests them:

```bash
node tools/check-relays.mjs
```

## Online version

The same app is on the web at **https://eliv3n.github.io/habla/**. It works in any modern browser, on a computer or a phone, with nothing to start first.

- Microsoft Edge on a computer has the best Spanish voices. On a phone the app uses the phone's own Spanish voice.
- Progress on the website is saved in that browser, on that device, separately for each person. A device that was connected with the family link shares it with the other connected devices, and with the copy on this computer.
- Anyone who opens the website sees the names, but never anybody's progress: without the family link nobody can read it.
- The website is a public GitHub Pages site. It changes only when the files in this folder are pushed to GitHub.

## The plan

84 sessions of about 30 minutes: 12 weeks of 7 days. Three months has about 90 days, so you have a week of spare days.

| Day | What you do |
| --- | --- |
| 1 to 5 | **Lesson.** Warm-up review, listen to a conversation, learn about nine phrases, build new sentences, shadow and role-play, talk freely for one minute |
| 6 | **Review.** Listening test without text, speaking review, check what you can do |
| 7 | **Mission.** A real conversation of 10 to 15 minutes with an AI voice partner or a person |

| Week | Topic | Week | Topic |
| --- | --- | --- | --- |
| 1 | First words | 7 | Plans and invitations |
| 2 | Food and drink | 8 | Talking about the past |
| 3 | About me | 9 | Health and problems |
| 4 | Getting around | 10 | Conversation tools |
| 5 | Time and daily life | 11 | People and feelings |
| 6 | Shopping and money | 12 | Real conversations |

The course has 60 lessons, 569 phrases, 485 lines of conversation and 421 sentence-building prompts, using about 750 different word forms.

## What to expect

Thirty minutes a day for 12 weeks is about 42 hours. That is not enough for fluency. It is enough to reach roughly the A1 "survival" level in speaking and listening: you can meet someone, talk about yourself, order, shop, ask the way, make plans, say what you did, and solve a simple problem. You will speak slowly and make mistakes, and people will understand you.

The **Method** page inside the app explains why the course is built this way and lists the research behind it.

## Three rules

1. **Answer out loud, always.** Thinking the answer trains your memory. Only saying it trains your mouth.
2. **Every day beats long sessions.** If you only have 10 minutes, do the warm-up.
3. **Do the Day 7 conversation.** It is the hardest step, and the one that turns phrases into communication.

## Keys

| Key | What it does |
| --- | --- |
| Space | The main button: start, pause, speak, show the answer, next |
| S | Show the answer without using the microphone |
| R / W | Hear it again / hear it slowly |
| T | Try the microphone again |
| 1 / 2 / 3 | Missed / Almost / Got it |
| Enter | Next step, when the step is finished |
| ← / → | Previous / next phrase while listening and repeating |

## Outside your 30 minutes

- The **Listen** page plays the conversations from every lesson you have finished, one after another. Good for walking, cooking or commuting.
- The voices in the app are synthetic. From week 3 or 4, add real voices when you can: [Language Transfer: Complete Spanish](https://www.languagetransfer.org/complete-spanish) (free audio course, 90 short tracks) and [Dreaming Spanish](https://www.dreaming.com/spanish) (videos for learners; start with "Superbeginner").

## Your progress

Progress is saved in the browser and in `progress.json` in this folder, separately for each person. To make a backup of one person's progress, choose their name, open **Settings** and choose **Save a backup file**.

If somebody practiced before the names were added, the app asks each new person once: "Is this progress yours?" The person who says yes continues from there.

## If something does not work

| Problem | What to do |
| --- | --- |
| No sound, or a robotic voice | Open the app in Microsoft Edge and check that you are online. Then use **Settings → Test** |
| The microphone check gets it wrong | It is strict and sometimes wrong. Compare yourself with the model voice. You can switch it off in **Settings** |
| Edge does not open | Open Edge yourself and go to `http://localhost:8642` |
| The window says "Habla is already running" | That is fine. The app opens in the browser |
| The voice speaks too fast | **Settings → Speaking speed**. Inside a lesson, press **W** to hear a phrase slowly |
| Progress does not appear on another device | Open the family link on that device once, in the same browser you use for Habla. Then look at **Settings → Other devices** |

## What was tested, and what was not

Tested automatically: complete lesson, review and mission sessions, the review schedule, saving and resuming, the launcher, and real synthetic speech running through a lesson. Also the list of people: separate progress for each person, coming back to the same place, and keeping progress from before the names were added. Also the sharing between devices: two browsers passing progress to each other, with no connection, with relays that fail, and with a whole finished course on the real relays.

Not tested: the microphone check with a real human voice. Only you can try that. If it does not work well for you, switch it off: you then say each answer out loud and check it yourself, which is how most audio courses work.

## Changing the course

The lessons are plain text in `data/week01.js` to `data/week12.js`. After any change, run this check:

```bash
node tools/check-course.js
```

You can ask Claude in this folder to make changes, for example:

- "Add five lessons about my job as a nurse."
- "The role 'you' is a man (Luis). Change it to a woman."
- "Read the Day 7 notes in progress.json and make extra practice for the words each person was missing."
- "Add another person to the list of names."

## Files

| Path | What it is |
| --- | --- |
| `Start Habla.cmd` | Starts the app |
| `index.html`, `css/`, `js/` | The app |
| `data/` | The 12 weeks of lessons |
| `data/profiles.js` | The names of the people who learn here |
| `data/sync.js` | The relays that carry progress between devices |
| `family-link.txt` | The family link. Private: it is never published |
| `tools/serve.ps1` | The small local server (Windows PowerShell, already on your computer) |
| `tools/check-course.js` | Checks the lesson files for mistakes |
| `tools/check-relays.mjs` | Tests the relays |
| `progress.json` | Everybody's progress (created when you start) |
