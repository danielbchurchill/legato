-- #281: the membership bound (enrich/queue.ts's MEMBER_LOOKUP_ARTISTS_SQL
-- and ARTISTS_IN_BOUND_SQL) steps along member_of edges from every artist a
-- recording names. edges_from_node_idx and edges_to_node_idx return all of
-- an artist's edges, so each step read every collaborated_with, same_label
-- and recording edge the artist has as well, once per recording it's on.
-- On a 3,000-album library that took 7 s to read the lookup set and 21 s
-- for the whole bound. These two hold only member_of edges, so a step reads
-- an artist's handful of memberships and nothing else.
CREATE INDEX edges_member_of_from_idx ON edges(from_node) WHERE type = 'member_of';
CREATE INDEX edges_member_of_to_idx ON edges(to_node) WHERE type = 'member_of';
