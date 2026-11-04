# Chatbox private media service

This Worker stores Chatbox photos, videos, voice recordings, and documents in a private Cloudflare R2 bucket. It authenticates Firebase ID tokens and checks the user's Chatbox approval before accepting uploads.

## Required Cloudflare setup

1. Create a private R2 bucket named `chatbox-media`.
2. Install Wrangler locally or use the Cloudflare dashboard's Worker editor.
3. Configure the R2 bucket binding named `MEDIA_BUCKET` to the `chatbox-media` bucket.
4. Add the Worker variable `FIREBASE_API_KEY` using the API key from the existing `firebase-config.js`.
5. Keep the bucket private. Do not enable public R2 access.
6. Deploy the Worker from this directory.

The other non-secret values are in `wrangler.toml`. The Worker checks non-owner users against the existing Firestore `allowed/{email}` approval document using the user's Firebase ID token. The owner email is allowed directly.

## API

- `POST /upload`: Firebase bearer token, raw file body, `X-Chat-Peer` recipient UID, `X-File-Name` original filename, and the file's content type. Maximum size is 50 MB.
- `GET /media/{key}`: Firebase bearer token. Only the two UIDs recorded on the R2 object can retrieve it.

The Worker returns a private object key and relative media URL. Do not make the R2 bucket public.

## Important

The current Chatbox frontend still stores legacy attachments as small data URLs. This Worker is infrastructure only; the frontend must be updated to upload files here and store the returned media reference in Firestore before large-file sending is enabled. Existing legacy messages remain readable.

If the Firestore security rules do not permit an approved user to read their own `allowed/{email}` document through the REST API, the Worker will fail closed with an authorization error. Verify the rule in Firebase Console rather than weakening database access globally.
