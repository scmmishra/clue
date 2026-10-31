---
title: Prompts
---

## Mention a file

Type `@` and search. `↑` and `↓` choose a row, `enter` adds the path to your message, and `tab` opens a folder. The search covers file names and folders. Claude reads the file when it needs it, so the prompt only holds the path.

## Add an image

Paste or drag an image file into the prompt. It shows as `[Image #1]`, and deleting that text removes the image. Paths to other files stay as text, and the model reads them with its tools. A terminal only passes on text, so for an image on the clipboard, press `ctrl+v` or run `/paste`. That works on macOS.

## While clue works

You can keep typing while clue works. `Tab` or `Enter` queues one message, and clue sends it when the turn ends. `↑` takes it back to edit. Press `esc` twice or `ctrl+c` to interrupt. An interrupt returns the queued message to the input. `shift+tab` changes the permission mode, even during a run.
