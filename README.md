# InnerCircle

**Your Facebook. Your Circle. Your Rules.**

InnerCircle is a browser extension designed to put you back in control of your Facebook feed.

Social media feeds are increasingly shaped by algorithms, recommendations, sponsored content, and posts from sources you never chose to follow. InnerCircle takes a different approach: it lets you define who and what you trust, then uses that information to help filter the noise.

[**Download InnerCircle.zip**](https://github.com/neverson42/innercircle/raw/refs/heads/main/InnerCircle.zip), extract the files to a folder, and load it as an unpacked extension.

## Instructions

1. Download and extract `InnerCircle.zip` to a folder of your choice.
2. Open your Chromium-based browser's extensions page:
   - Brave: `brave://extensions`
   - Chrome: `chrome://extensions`
3. Enable **Developer mode**.
4. Click **Load unpacked**.
5. Select the extracted `InnerCircle` folder (the one containing `manifest.json`).
6. InnerCircle should now appear in your extensions list and browser toolbar.

**Important:** Keep the extracted folder in place. If you move or delete it, the extension will stop working.

Once installed, InnerCircle does nothing until you build the database.

1. Open Facebook in your browser and log in.
2. Click the InnerCircle extension icon to open its settings.
3. Click **Build Database** to begin collecting your Facebook connections.
4. InnerCircle will open the necessary Facebook pages and collect your friends, groups, and followed pages and people. 
5. Allow the process to finish. Depending on the size of your network, this may take several minutes. **Interacting with the browser during the build process may interrupt the process and fail to build the database.**
6. Once complete, your database is ready and InnerCircle can begin filtering your Facebook feed.

**A few things to know:**

- You must be logged into Facebook for the database build to work.
- Keep the browser open while the database is being built.
- Building the database creates a fresh snapshot of your current Facebook connections. It does not permanently accumulate old or removed connections.
- You can rebuild the database whenever you want to refresh your trusted network. Do this whenever you add friends, join groups, or follow new pages.

Once the database is built, just browse Facebook normally. InnerCircle works in the background.

## How It Works

InnerCircle builds a local database of your Facebook connections, including:

- **Friends** — People you've connected with on Facebook.
- **Groups** — Facebook groups you've joined.
- **Following** — Pages and people you choose to follow.

Using this database, InnerCircle evaluates posts in your Facebook feed against your own trusted network, hiding everything that you dont explicitly choose to see.

## Privacy First

Privacy isn't an optional feature of InnerCircle. It's a foundational design principle.

- **Local storage:** Your InnerCircle database stays in your browser.
- **No external servers:** Your data isn't sent to a third-party service.
- **No Facebook API:** InnerCircle works with the Facebook interface rather than relying on Facebook's developer API.
- **Minimal permissions:** The extension requests only the browser permissions needed to perform its functions.
- **No accounts:** No registration, subscriptions, or separate user accounts.

Your trusted network belongs to you.

## What InnerCircle Is Not

InnerCircle is not an ad blocker (though it does give you that as a side-effect), a content moderation service, or an algorithm designed to tell you what matters.

It doesn't attempt to judge the quality or accuracy of content. It simply gives you greater control over which sources you consider part of your trusted network.

## Project Philosophy

The internet was supposed to connect us with people and communities we care about. Somewhere along the way, platforms started deciding what we should see.

InnerCircle is my attempt to take some of that control back.

## Status

InnerCircle is an independent, mostly-chatgpt-generated project developed by a guy who got sick of seeing fake, AI generated images of Jason Mamoa visiting every mom and pop shop within 100 miles of where he lives.

Facebook frequently changes its interface, and those changes may affect extension functionality. Compatibility and functionality are subject to ongoing development. I'll try to stay on top of it because, mostly, this is made for me. I use Brave browser (chromium based) and it is verified to work there. It should work on any chromium browser, but I dont intend to make any browser-specific changes. If it doesnt work for you, clone the repo and make something that does.

I am not a verified developer and don't want to pay the $5 to become one, so this extension needs to be run in developer mode.

## Disclaimer

InnerCircle is an independent project and is not affiliated with, endorsed by, or sponsored by Meta Platforms, Inc. or Facebook.

Facebook is a trademark of Meta Platforms, Inc.
