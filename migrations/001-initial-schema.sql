-- Up
CREATE TABLE meta (
  latestNoteTime TIMESTAMP,
  lastBearDBCheckTime TIMESTAMP,
  brokenLinkNoteID VARCHAR
);
INSERT INTO
  meta
VALUES
  (NULL, NULL, NULL);
CREATE TABLE titles (
    id VARCHAR PRIMARY KEY NOT NULL,
    title VARCHAR NOT NULL
  );
CREATE TABLE links (
    fromID VARCHAR NOT NULL,
    toID VARCHAR,
    linkTitle VARCHAR,
    CONSTRAINT links_fk_fromID FOREIGN KEY (fromID) REFERENCES titles (id),
    CONSTRAINT links_fk_toID FOREIGN KEY (toID) REFERENCES titles (id)
  );
-- Down
  DROP TABLE meta;
DROP TABLE titles;
DROP TABLE links;