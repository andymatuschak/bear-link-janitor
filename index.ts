import { promises as fs, link } from "fs";
import * as child_process from "child_process";
import * as os from "os";
import * as path from "path";
import * as sqlite from "sqlite";
import * as util from "util";
const exec = util.promisify(child_process.exec);

const bearDatabasePath = path.join(
  os.homedir(),
  "Library/Group Containers/9K33E3U3T4.net.shinyfrog.bear/Application Data/database.sqlite",
);

type BearEntry = {
  title: string;
  id: string;
  links: Set<string>;
};

type TitleChange = Map<
  string,
  {
    oldTitle: string;
    newTitle: string;
  }
>;

async function checkBearDatabaseForModifications(
  lastBearDBCheckTime: number,
): Promise<boolean> {
  const stat = await fs.stat(bearDatabasePath);
  return stat.mtime.getTime() > lastBearDBCheckTime;
}

async function openBearDatabase(): Promise<sqlite.Database> {
  return sqlite.open(bearDatabasePath);
}

async function openLinkMaintainerDatabase(): Promise<sqlite.Database> {
  const db = await sqlite.open(path.join(__dirname, "linkDB.sqlite"));
  return db.migrate({});
}

const linkRegex = /\[\[(.+?)\]\]/g;

async function getChangedBearEntries(
  bearDatabase: sqlite.Database,
  latestNoteTime: number | null,
): Promise<BearEntry[]> {
  const results = await bearDatabase.all(
    `SELECT ZTITLE, ZUNIQUEIDENTIFIER, ZTEXT FROM ZSFNOTE WHERE ZTRASHED LIKE '0'${
      latestNoteTime ? ` AND ZMODIFICATIONDATE >= ${latestNoteTime}` : ""
    }`,
  );

  function getLinks(text: string): Set<string> {
    return new Set(
      [...text.matchAll(linkRegex)].map(matchedLink => matchedLink[1]),
    );
  }

  return results.map(result => ({
    title: result.ZTITLE,
    id: result.ZUNIQUEIDENTIFIER,
    links: getLinks(result.ZTEXT),
  }));
}

function getLinkDBMetadata(
  linkDatabase: sqlite.Database,
): Promise<{
  latestNoteTime: number | null;
  lastBearDBCheckTime: number | null;
  brokenLinkNoteID: string | null;
}> {
  return linkDatabase.get("SELECT * FROM meta");
}

function writeLinkDBMetadata(
  linkDatabase: sqlite.Database,
  latestNoteTime: number | null,
  brokenLinkNoteID: string | null,
): Promise<any> {
  return linkDatabase.exec(
    `UPDATE meta SET latestNoteTime = ${latestNoteTime}, lastBearDBCheckTime = ${Date.now()}, brokenLinkNoteID = ${
      brokenLinkNoteID ? `'${brokenLinkNoteID}'` : "NULL"
    }`,
  );
}

const queryParameterLimit = 999;
type QueryParameterType = string | null;

async function runQuery<Element extends QueryParameterType, Return>(
  fn: (query: string, parameters: QueryParameterType[]) => Promise<Return>,
  queryFormatter: (placeholderList: string) => string,
  elements: Element[],
  visitor?: (results: Return) => Promise<void>,
): Promise<void> {
  let workingElements = elements;
  do {
    const iterationElements = workingElements.slice(0, queryParameterLimit);
    const placeholderList = iterationElements.map(_ => "?").join(",");
    const queryString = queryFormatter(placeholderList);
    const results = await fn(queryString, iterationElements);
    if (visitor) {
      await visitor(results);
    }
    workingElements = workingElements.slice(queryParameterLimit);
  } while (workingElements.length > 0);
}

async function runTupleQuery<
  Element extends [QueryParameterType, QueryParameterType],
  Return
>(
  fn: (query: string, parameters: QueryParameterType[]) => Promise<Return>,
  queryFormatter: (placeholderList: string) => string,
  elements: Element[],
  visitor?: (results: Return) => Promise<void>,
): Promise<void> {
  const localLimit = Math.floor(queryParameterLimit / 2);

  let workingElements = elements;
  do {
    const iterationElements = workingElements.slice(0, localLimit);
    const placeholderList = iterationElements.map(_ => "(?,?)").join(",");
    const queryString = queryFormatter(placeholderList);
    const results = await fn(queryString, iterationElements.flat());
    if (visitor) {
      await visitor(results);
    }
    workingElements = workingElements.slice(localLimit);
  } while (workingElements.length > 0);
}

async function runTripleQuery<
  Element extends [QueryParameterType, QueryParameterType, QueryParameterType],
  Return
>(
  fn: (query: string, parameters: QueryParameterType[]) => Promise<Return>,
  queryFormatter: (placeholderList: string) => string,
  elements: Element[],
  visitor?: (results: Return) => Promise<void>,
): Promise<void> {
  const localLimit = Math.floor(queryParameterLimit / 3);

  let workingElements = elements;
  do {
    const iterationElements = workingElements.slice(0, localLimit);
    const placeholderList = iterationElements.map(_ => "(?,?,?)").join(",");
    const queryString = queryFormatter(placeholderList);
    const results = await fn(queryString, iterationElements.flat());
    if (visitor) {
      await visitor(results);
    }
    workingElements = workingElements.slice(localLimit);
  } while (workingElements.length > 0);
}

async function getChangedTitles(
  changedBearEntries: BearEntry[],
  linkDatabase: sqlite.Database,
): Promise<TitleChange> {
  type TitleChangeEntry = { id; newTitle; oldTitle };
  let changeEntries: TitleChange = new Map();

  await runTupleQuery(
    linkDatabase.all.bind(linkDatabase),
    placeholderList =>
      `WITH newIDs(id,title) AS (VALUES ${placeholderList}) SELECT newIDs.id AS id, newIDs.title AS newTitle, titles.title AS oldTitle FROM newIDs INNER JOIN titles ON (newIDs.id = titles.id) WHERE newIDs.title != titles.title`,
    changedBearEntries.map(({ id, title }): [string, string] => [id, title]),
    async (iterationChangeEntries: TitleChangeEntry[]) => {
      for (const entry of iterationChangeEntries) {
        changeEntries.set(entry.id, {
          oldTitle: entry.oldTitle,
          newTitle: entry.newTitle,
        });
      }
    },
  );
  return changeEntries;
}

async function updateBrokenLinks(
  bearDatabase: sqlite.Database,
  linkDatabase: sqlite.Database,
  changedBearEntries: BearEntry[],
  titleChanges: TitleChange,
): Promise<BearEntry[]> {
  console.debug("Title changes", titleChanges);

  // Find all the IDs with links to the entries with changed titles
  const updateMap: Map<string, string[]> = new Map();
  await runQuery(
    linkDatabase.all.bind(linkDatabase),
    placeholderList =>
      `SELECT fromID, toID FROM links WHERE toID IN (${placeholderList})`,
    [...titleChanges.keys()],
    async (results: { fromID: string; toID: string }[]) => {
      for (const { fromID, toID } of results) {
        updateMap.set(fromID, [toID, ...(updateMap.get(fromID) || [])]);
      }
    },
  );

  console.debug("Update map", updateMap);

  const newChangedBearEntries = [...changedBearEntries];

  await runQuery(
    bearDatabase.all.bind(bearDatabase),
    placeholderList =>
      `SELECT ZUNIQUEIDENTIFIER AS id, ZTITLE AS title, ZTEXT AS text FROM ZSFNOTE WHERE id IN (${placeholderList})`,
    [...updateMap.keys()],
    async (oldTexts: { id: string; title: string; text: string }[]) => {
      for (const { id, text, title } of oldTexts) {
        let newText = text;
        const oldEntryIndex = changedBearEntries.findIndex(
          entry => entry.id === id,
        );

        if (oldEntryIndex !== -1) {
          newChangedBearEntries[oldEntryIndex].links = new Set([
            ...newChangedBearEntries[oldEntryIndex].links,
          ]);
        }

        for (const brokenLinkID of updateMap.get(id)!) {
          const { oldTitle, newTitle } = titleChanges.get(brokenLinkID)!;
          console.log(
            `Replacing link in ${title} (${id}): ${oldTitle} => ${newTitle}`,
          );

          const escapedOldTitle = oldTitle.replace(
            /[.*+?^${}()|[\]\\]/g,
            "\\$&",
          );

          newText = newText.replace(
            new RegExp(`\\[\\[${escapedOldTitle}\\]\\]`, "g"),
            `[[${newTitle}]]`,
          );

          if (oldEntryIndex !== -1) {
            // Now update the links entries we originally had fetched from the database.
            newChangedBearEntries[oldEntryIndex].links.delete(oldTitle);
            newChangedBearEntries[oldEntryIndex].links.add(newTitle);
          }
        }

        function splitLines(t: string) {
          return t.split(/\r\n|\r|\n/);
        }

        // Is the title on the first line?
        const textLines = splitLines(newText);
        const titleInText = textLines[0].replace(/^#+ /, "");
        if (titleInText === title) {
          newText = textLines.slice(1).join("\n");
        }

        const escapedText = encodeURIComponent(newText);
        const bearURL = `bear://x-callback-url/add-text?open_note=no&show_window=no&mode=replace&id=${id}&text=${escapedText}`;

        await exec(`open -g "${bearURL}"`);
      }
    },
  );

  return newChangedBearEntries;
}

function recordTitles(
  linkDatabase: sqlite.Database,
  bearEntries: BearEntry[],
): Promise<any> {
  return runTupleQuery(
    linkDatabase.run.bind(linkDatabase),
    placeholderString =>
      `REPLACE INTO titles (id, title) VALUES ${placeholderString}`,
    bearEntries.map(({ id, title }): [string, string] => [id, title]),
  );
}

// Returns the UUID of the Bear note displaying broken link information, if there is any
async function recordLinks(
  linkDatabase: sqlite.Database,
  bearEntries: BearEntry[],
  brokenLinkNoteID: string | null,
): Promise<string | null> {
  let newBrokenLinkNoteID = brokenLinkNoteID;

  // While we're at it, we'll check to see if any pre-existing broken links are fixed.
  let currentBrokenLinkEntries: {
    fromID: string;
    linkTitle: string;
  }[] = [];
  await runQuery(
    linkDatabase.all.bind(linkDatabase),
    placeholderString =>
      `SELECT fromID, linkTitle FROM links WHERE toID IS NULL AND fromID NOT IN (${placeholderString})`,
    bearEntries.map(({ id }) => id),
    async (results: { fromID: string; linkTitle: string }[]) => {
      currentBrokenLinkEntries = currentBrokenLinkEntries.concat(results);
    },
  );
  if (currentBrokenLinkEntries.length > 0) {
    console.debug("Previously broken links", currentBrokenLinkEntries);
    // Drop all those old broken links. We'll replace them if they're unfixed.
    console.debug("Deleting old broken links");
    await runTupleQuery(
      linkDatabase.run.bind(linkDatabase),
      placeholderString =>
        `DELETE FROM links WHERE (fromID, linkTitle) IN (VALUES ${placeholderString})`,
      currentBrokenLinkEntries.map(({ fromID, linkTitle }): [
        string,
        string,
      ] => [fromID, linkTitle]),
    );
  } else {
    console.debug("No previously broken links");
  }

  console.debug("Deleting old links from changed notes");
  // Then drop links for any notes which changed.
  await runQuery(
    linkDatabase.run.bind(linkDatabase),
    placeholderString =>
      `DELETE FROM links WHERE fromID IN (${placeholderString})`,
    bearEntries.map(({ id }) => id),
  );

  const linksToCheck: [string, string][] = currentBrokenLinkEntries
    .map((brokenLink): [string, string] => [
      brokenLink.fromID,
      brokenLink.linkTitle,
    ])
    .concat(
      bearEntries.flatMap(({ id, links }) =>
        [...links].map((link): [string, string] => [id, link]),
      ),
    );

  if (linksToCheck.length > 0) {
    // Look up the destinations for all the links we've collected.
    let ambiguousLinks: Map<string, Map<string, string[]>> = new Map(); // fromID -> linkTitle -> [toID]
    let newLinkEntries: Map<string, Map<string, string | null>> = new Map(); // fromID -> linkTitle -> toID
    await runTupleQuery(
      linkDatabase.all.bind(linkDatabase),
      placeholderString =>
        `WITH newIDs(id,linkTitle) AS (VALUES ${placeholderString}) SELECT newIDs.id AS fromID, titles.id AS toID, newIDs.linkTitle AS linkTitle FROM newIDs LEFT JOIN titles ON (titles.title = newIDs.linkTitle)`,
      linksToCheck,
      async (
        results: { fromID: string; toID: string | null; linkTitle: string }[],
      ) => {
        // Scan for ambiguous links as we incorporate the results.
        for (const { fromID, toID, linkTitle } of results) {
          let existingEntryForFromID = newLinkEntries.get(fromID);
          if (!existingEntryForFromID) {
            existingEntryForFromID = new Map();
            newLinkEntries.set(fromID, existingEntryForFromID);
          }

          const existingToIDForLinkTitle = existingEntryForFromID.get(
            linkTitle,
          );
          if (toID && existingToIDForLinkTitle !== undefined) {
            // We've found an ambiguous link which could refer to multiple notes.
            let existingAmbiguousEntryForFromID = ambiguousLinks.get(fromID);
            if (!existingAmbiguousEntryForFromID) {
              existingAmbiguousEntryForFromID = new Map();
              ambiguousLinks.set(fromID, existingAmbiguousEntryForFromID);
            }

            const existingAmbiguousToIDs = existingAmbiguousEntryForFromID.get(
              linkTitle,
            );
            if (existingAmbiguousToIDs) {
              existingAmbiguousEntryForFromID.set(linkTitle, [
                toID,
                ...existingAmbiguousToIDs,
              ]);
            } else {
              if (existingToIDForLinkTitle === null) {
                throw new Error(
                  `Unexpected null entry in link list ${fromID} ${linkTitle} ${toID}`,
                );
              }
              existingAmbiguousEntryForFromID.set(linkTitle, [
                toID,
                existingToIDForLinkTitle!,
              ]);
              existingEntryForFromID.set(linkTitle, null);
            }
          } else {
            existingEntryForFromID.set(linkTitle, toID);
          }
        }
      },
    );

    if (ambiguousLinks.size > 0) {
      console.log("FOUND AMBIGUOUS LINKS", ambiguousLinks);
    }

    // Then insert records for the links we've found.
    await runTripleQuery(
      linkDatabase.run.bind(linkDatabase),
      placeholderString =>
        `INSERT INTO links (fromID, toID, linkTitle) VALUES ${placeholderString}`,
      [...newLinkEntries.keys()].flatMap((fromID: string): [
        string,
        string | null,
        string | null,
      ][] =>
        [...newLinkEntries.get(fromID)!.entries()].map(([linkTitle, toID]): [
          string,
          string | null,
          string | null,
        ] => [fromID, toID, toID ? null : linkTitle]),
      ),
    );

    // Now we take a look at all our broken links and write a debug file for them.
    // TODO factor all this out.
    const brokenLinkFromIDs: Set<string> = new Set();
    newLinkEntries.forEach((linkMap, fromID) => {
      linkMap.forEach((toID, linkTitle) => {
        if (!toID) {
          brokenLinkFromIDs.add(fromID);
        }
      });
    });

    if (brokenLinkFromIDs.size > 0) {
      console.log("Creating broken link note.");
      // Get the titles for all the from IDs
      const brokenLinkTitleMap: Map<string, string> = new Map(); // fromID -> title
      await runQuery(
        linkDatabase.all.bind(linkDatabase),
        placeholderString =>
          `SELECT id, title FROM titles WHERE id IN (${placeholderString})`,
        [...brokenLinkFromIDs],
        async (results: { id: string; title: string }[]) => {
          for (const { id, title } of results) {
            brokenLinkTitleMap.set(id, title);
          }
        },
      );

      let brokenLinkNoteText = "";
      newLinkEntries.forEach((linkMap, fromID) => {
        linkMap.forEach((toID, linkTitle) => {
          if (!toID) {
            const ambiguousEntryForFromID = ambiguousLinks.get(fromID);
            if (
              ambiguousEntryForFromID &&
              ambiguousEntryForFromID.get(linkTitle)
            ) {
              brokenLinkNoteText += `* Ambiguous link in [${brokenLinkTitleMap.get(
                fromID,
              )}](bear://x-callback-url/open-note?new_window=yes&id=${fromID}) to "${linkTitle}". Could be:\n${ambiguousEntryForFromID
                .get(linkTitle)!
                .map(
                  toID =>
                    `  * [${linkTitle}](bear://x-callback-url/open-note?new_window=yes&id=${toID})]\n`,
                )
                .join("")}`;
            } else {
              brokenLinkNoteText += `* Dead link in [${brokenLinkTitleMap.get(
                fromID,
              )}](bear://x-callback-url/open-note?new_window=yes&id=${fromID}) to "${linkTitle}" ([create](bear://x-callback-url/create?edit=yes&title=${encodeURIComponent(
                linkTitle,
              )}))\n`;
            }
          }
        });
      });
      brokenLinkNoteText += `\nLast updated ${new Date().toLocaleString()}`;

      newBrokenLinkNoteID = await updateBrokenLinkNoteText(
        brokenLinkNoteID,
        brokenLinkNoteText,
      );
    } else if (brokenLinkNoteID) {
      newBrokenLinkNoteID = null;
    }
  } else if (brokenLinkNoteID) {
    newBrokenLinkNoteID = null;
  }

  if (brokenLinkNoteID && !newBrokenLinkNoteID) {
    await deleteBrokenLinkNote(brokenLinkNoteID);
  }

  return newBrokenLinkNoteID;
}

async function deleteBrokenLinkNote(brokenLinkNoteID: string) {
  await exec(
    `open -g "bear://x-callback-url/trash?id=${brokenLinkNoteID}&show_window=no"`,
  );
}

async function updateBrokenLinkNoteText(
  brokenLinkNoteID: string | null,
  brokenLinkNoteText: string,
): Promise<string> {
  if (brokenLinkNoteID) {
    // update it.
    await exec(
      `open -g "bear://x-callback-url/add-text?&open_note=no&new_window=no&mode=replace&id=${brokenLinkNoteID}&text=${encodeURIComponent(
        brokenLinkNoteText,
      )}"`,
    );
    return brokenLinkNoteID;
  } else {
    const { stdout } = await exec(
      `${path.join(
        __dirname,
        "xcall/build/Release/xcall.app/Contents/MacOS/xcall",
      )} -activateApp NO -url "bear://x-callback-url/create?pin=yes&open_note=no&new_window=no&title=${encodeURIComponent(
        "🚨 Broken Note Links!",
      )}&text=${encodeURIComponent(brokenLinkNoteText)}"`,
    );
    const newEntryDetails = JSON.parse(stdout);
    return newEntryDetails.identifier;
  }
}

async function getLatestBearNoteTime(
  bearDatabase: sqlite.Database,
): Promise<number> {
  const result = await bearDatabase.get(
    "SELECT MAX(ZMODIFICATIONDATE) AS latestBearNoteTime FROM ZSFNOTE",
  );
  return result.latestBearNoteTime;
}

(async () => {
  const linkDatabase = await openLinkMaintainerDatabase();
  const metadata = await getLinkDBMetadata(linkDatabase);
  console.debug(`Checking for changes at ${new Date().toLocaleString()}...`);

  let newLatestNoteTime: number | null = metadata.latestNoteTime;
  let newBrokenLinkNoteID: string | null = metadata.brokenLinkNoteID;
  if (
    metadata.lastBearDBCheckTime === null ||
    (await checkBearDatabaseForModifications(metadata.lastBearDBCheckTime))
  ) {
    console.log("Bear database has changed. Scanning for broken links.");

    const bearDatabase = await openBearDatabase();
    let changedBearEntries = await getChangedBearEntries(
      bearDatabase,
      metadata.latestNoteTime,
    );
    console.debug(`${changedBearEntries.length} changed entries`);

    console.debug("Looking for titles which changed");
    const changedTitles = await getChangedTitles(
      changedBearEntries,
      linkDatabase,
    );

    if (changedTitles.size > 0) {
      changedBearEntries = await updateBrokenLinks(
        bearDatabase,
        linkDatabase,
        changedBearEntries,
        changedTitles,
      );
    }

    console.debug("Recording titles");
    await recordTitles(linkDatabase, changedBearEntries);
    console.debug("Recording links");
    newBrokenLinkNoteID = await recordLinks(
      linkDatabase,
      changedBearEntries,
      metadata.brokenLinkNoteID,
    );

    console.debug("Recording metadata");
    newLatestNoteTime = await getLatestBearNoteTime(bearDatabase);
  } else {
    console.debug("Nothing to do.");
  }
  await writeLinkDBMetadata(
    linkDatabase,
    newLatestNoteTime,
    newBrokenLinkNoteID,
  );
})()
  .catch(console.error)
  .finally(() => {
    console.log("Done");
    process.exit(0);
  });
