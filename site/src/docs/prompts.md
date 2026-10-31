---
title: Prompts
---

## Mention a file

Type `@` and search. `↑` and `↓` choose a row, `enter` adds the path to your message, and `tab` opens a folder. The search covers file names and folders. Claude reads the file when it needs it, so the prompt only holds the path.

## Add an image

Paste or drag an image file into the prompt. It shows as `[Image #1]`, and deleting that text removes the image. Paths to other files stay as text, and the model reads them with its tools. A terminal only passes on text, so for an image on the clipboard, press `ctrl+v` or run `/paste`. That works on macOS.

## While clue works

You can keep typing while clue works. `Enter` steers the turn: clue sends your message with the next tool results, so Claude reads it before its next step. If the turn ends first, the message goes as the next prompt. `Tab` queues one message for after the turn instead. A command such as `/usage` always queues. `↑` takes back the steering message, then the queued one, to edit. Press `esc` twice or `ctrl+c` to interrupt. An interrupt returns both to the input. `shift+tab` changes the permission mode, even during a run.
