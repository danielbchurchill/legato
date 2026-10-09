-- Issue #324: which server a claim is for.
--
-- A setup code is 40 bits, and the proof a server signs to redeem one
-- (linked-servers.ts, claimProofSigned) costs nothing to make: any key will
-- do. So whoever guessed a code someone had just claimed could redeem it
-- for a server of their own, and the claiming account's link would go to a
-- server its owner never saw. Now the QR on a server's /setup page carries
-- the server's id as well as its code (legato.fm/claim?code=…&server=…),
-- the claim page passes it to POST /pair/claim, and it's kept here.
-- POST /pair/exchange redeems a code only for the server named here, and
-- answers any other exactly as it would a code nobody claimed.
--
-- NULL for a claim made before this, and for a code minted by POST
-- /pair/start, which #353 removed. No server can redeem either, and both
-- expire ten minutes after they were made.
ALTER TABLE pairing_codes ADD COLUMN server_id TEXT;

-- The link token redeeming the code handed its server, kept so that if the
-- answer never reached the server, asking again gets the same token for as
-- long as the claim lasts (routes/pair.ts). One claim, one token, and so one
-- credential, however often the answer is lost.
ALTER TABLE pairing_codes ADD COLUMN link_token TEXT;
