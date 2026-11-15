/* Where progress goes when a device is connected to the family (see js/sync.js).

   These are public relays of the open Nostr network: plain servers that keep small
   signed notes and need no account. They only receive progress that is already
   sealed with the family key, so they cannot read it. Each relay is run by somebody
   else, with no promise that it stays. That is why there are several, and why every
   device also keeps its own full copy.

   If a relay stops working, replace it here. The devices put their copy on the new
   one by themselves. To test relays:  node tools/check-relays.mjs
   Last checked: 2026-11-15. */
window.SYNC = {
  // The address the family link points to, also when the app runs from the folder on this computer.
  site: 'https://eliv3n.github.io/habla/',
  relays: [
    'wss://relay.primal.net',
    'wss://relay.snort.social',
    'wss://relay.nostr.net',
    'wss://nostr.oxtr.dev',
    'wss://soloco.nl',
  ],
};
