# Bear Link Janitor

[https://bear.app](Bear) is a nice app for writing notes. One thing that makes it nice is that you can make [[wiki-style links]] to other notes, with nice autocompleting search for the linked notes' titles.

Unfortunately, one not-so-nice thing is that the link is made _by-name_, not by any kind of durable reference, so if you use this feature, you'll end up with a proliferation of broken links as you occasionally change notes' titles. Or if you ever accidentally make two notes have the same title.

The developers have said that they plan to fix this at some point, but I found myself having to actively avoid this bug as I created and edited notes, so I made a band-aid to hold myself over.

This script tries to keep your Bear library's links in good shape by:

1. Watching for changes to note titles and correcting any links to the changed title
2. Notifying you of links to notes that don't exist
3. Notifying you of ambiguous links to multiple notes sharing the same title.

## Disclaimer

I'm sharing this as something like an "FYI," not to Create an Open Souce Project. I won't offer support and probably won't accept patches.

The code was, well, written in anger… so it's not terribly defensive or well structured. You should make backups of your library before running this for the first time (and probably regularly thereafter). I've been running it for a while, but it may or may not work reasonably for you.

## Use

You'll need Node 12.

```
yarn install
yarn run install
```

To uninstall:

```
yarn run uninstall
```

## Limitations

- Right now, this just polls for changes to the Bear database once a minute. This is pretty inefficient. It'd be better to make a long-lived process which monitor the database for writes using a GCD source and wakes up only when needed. But at least it's pretty fast; I've tested this on 10k note libraries.
- Notes aren't tracked as they move into and out of the trash.
- If you make a link to a note, then later change some other note to have the same name as that first note, we won't notice.
- If you're making edits to notes in Bear which have broken links while this script runs, it might fight with your edits.
- When you resolve all the link issues, the agent will remove its warning note from Bear, but it'll focus the Trash in the interface (unfortunately the callback API doesn't let you delete a note without focusing the trash)
- When this script fixes broken links, the notes end up modified, so they move to the top of the list of notes in the Bear UI. This is annoying, but I don't see a way around it.
