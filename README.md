# ThreadTrace

<img src="icons/icon128.png" alt="ThreadTrace logo" width="96">

Threads shows you what people are saying. ThreadTrace helps you remember who matters and explore what happened next.

A Chrome extension by Önder Samet for the Meta Global AI Developer Hackathon, powered by Meta Muse Spark.

## What it does

- Add private local labels and notes to people on Threads.
- Browse your tags in a side panel and view matching posts already loaded on a Threads page.
- Ask “What happened next?” about a public post. With your consent, the extension sends the post text and URL to Meta Model API using `muse-spark-1.3` and shows the model's answer.
- Save a follow-up and optionally schedule checks while Chrome is running. Scheduled comparisons are an experimental prototype, not a verified news-alert service.
- Switch the interface between English and Turkish. English is the default.

## Install

1. Download this repository and extract it, or clone it.
2. Open `chrome://extensions` in Chrome and enable **Developer mode**.
3. Choose **Load unpacked**, then select the folder containing `manifest.json`.
4. Open or refresh `https://www.threads.com/`. Sign in to Threads if needed.
5. Open the extension side panel and select **How to use**.

For AI research, open the side panel's **Settings**, save your own Meta Model API key, and grant access to `api.meta.ai`. Using the model may incur API charges. The app does not include a shared API key.

## Privacy and limitations

Labels, notes, preferences and follow-up results are stored locally in this Chrome profile. The API key is stored locally in the extension's IndexedDB **without encryption**, persists across restarts, and can be removed in Settings. Anyone with sufficient access to the browser profile or device may be able to retrieve it. Research sends the approved public post text and URL to Meta; labels and notes are not included. Scheduled follow-ups send the selected event text and, for comparisons, the previous report.

- Research results may be wrong, incomplete, or lack citations. Treat them as model output, not verified fact.
- Automatic monitoring requires Chrome to be running, a valid API key and permission. It can incur charges, runs on Chrome's alarm schedule and may be delayed.
- The first scheduled check establishes a baseline; later checks ask Muse to identify possible new developments. Classification and notifications have not been verified end to end against live changes. A one-day follow-up may expire before a second comparison.
- The tag feed includes only matching posts already loaded on the current page (and legacy locally saved posts), not a complete Threads search or archive.
- This is a hackathon prototype, not an official Meta or Threads product. Threads UI changes can break the extension.

## Built with Meta

The research feature calls the Meta Model API Responses endpoint using Muse Spark 1.3 and its web-search tool. Muse Code and other coding assistants were used during development; do not interpret “Built with Muse” as a claim that every line was authored by Muse Code.

## License and third-party notices

See `LICENSES/Lucide-ISC.txt` for the Lucide icon notice. All other source code is provided for hackathon evaluation; no additional open-source license is granted in this repository.
