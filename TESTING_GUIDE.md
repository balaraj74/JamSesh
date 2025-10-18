# Host Reassignment Testing Guide

## How to Test the Fix

### Setup
1. Server is running on `http://localhost:8080`
2. Open browser console (F12) to see debug logs
3. You need TWO browser tabs/windows

### Test Scenario 1: Host Ends Jam
1. **Tab 1 (Host):**
   - Go to http://localhost:8080
   - Enter username: "Host1"
   - Click "Host a Jam"
   - Copy the room code
   - Click "Start Jam" and share audio

2. **Tab 2 (Participant):**
   - Go to http://localhost:8080
   - Enter username: "Participant1"
   - Click "Join a Jam"
   - Enter the room code from Tab 1
   - You should hear the host's audio

3. **Tab 1 (Host):**
   - Click "End Jam" button

4. **Expected Result in Tab 2:**
   - ✅ Alert popup: "You are now the host!"
   - ✅ UI changes:
     - "Live Stream" section disappears
     - "You (Host Stream)" section appears
     - "Exit" button disappears
     - "Start Jam (You are Host)" button appears
     - "End Jam" button appears (disabled)
   - ✅ Console logs show:
     - "🎉 You have been promoted to host!"
     - "✅ Showed local audio wrapper"
     - "✅ Hid remote audio wrapper"
     - "✅ Enabled start button"
     - "✅ Hid exit button"

5. **Tab 2 (New Host):**
   - Click "Start Jam (You are Host)"
   - Share your audio
   - ✅ Should start streaming

### Test Scenario 2: Host Disconnects
1. Set up same as Scenario 1 (Steps 1-2)
2. **Tab 1 (Host):**
   - Close the tab/window completely (or press Ctrl+W)

3. **Expected Result in Tab 2:**
   - Same as Scenario 1, step 4

### What to Check in Browser Console

#### Server Logs (terminal):
```
Host [id] ended the call in room [code]
Promoting [id] ([username]) to host in room [code]
Sending host-promoted to [username] ([id]): { type: 'host-promoted', ... }
```

#### Client Logs (browser console Tab 2):
```
🎉 You have been promoted to host!
Promotion data: { type: 'host-promoted', newHostId: '...', isYou: true }
UI Elements found: { localAudioWrapper: true, remoteAudioWrapper: true, ... }
✅ Showed local audio wrapper
✅ Hid remote audio wrapper
✅ Enabled start button
✅ Showed end button
✅ Hid exit button
✅ Added event listener to start button
```

### Troubleshooting

If it doesn't work:
1. Check browser console for errors
2. Check server terminal for logs
3. Verify the room code is correct
4. Make sure both users are in the same room (check participants list)
5. Refresh and try again

### Common Issues

**Issue**: Alert shows but UI doesn't change
- **Check**: Are the console logs showing "UI Elements found: all true"?
- **Fix**: The elements might not exist in DOM

**Issue**: No alert appears
- **Check**: Server logs - is the promotion message being sent?
- **Check**: Is `isYou: true` in the message?

**Issue**: Start button doesn't work
- **Check**: Console logs when clicking button
- **Check**: Audio permissions granted?
