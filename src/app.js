import fs from "fs";
import path from "path";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import remarkGfm from "remark-gfm";
import remarkToc from "remark-toc";
import rehypeSlug from "rehype-slug";
import rehypeStringify from "rehype-stringify";
import gitDateExtractor from "git-date-extractor";
import userConfig from "../config.js";

const DOCS_DIR = path.resolve("./docs");
const OUTPUT_DIR = path.resolve("./dist");
const NAVIGATION = fs.readdirSync(DOCS_DIR).sort((a, b) => {
    const regex = /[0-9]+/;
    const [numA] = a.match(regex) || [-1];
    const [numB] = b.match(regex) || [-1];

    return +numA - +numB;
});
const TEMPLATE = fs.readFileSync(
    path.resolve("./theme/template.html"),
    "utf-8"
);
const TIMESTAMPS = Object.fromEntries(
    Object.entries(
        await gitDateExtractor.getStamps({
            onlyIn: DOCS_DIR,
        })
    ).map(([key, { created, modified }]) => [
        key.replace("docs/", ""),
        {
            createdAt: new Date(Number(created) * 1000).toISOString(),
            modifiedAt: new Date(Number(modified) * 1000).toISOString(),
        },
    ])
);
const CONFIG = {
    defaultTitle: userConfig.defaultTitle ?? "",
    baseURL: userConfig.baseURL ?? "/",
    useToc: userConfig.useToc ?? true,
};

/**
 * Create directory with given name
 *
 * @param {string} dirName
 */
function makeDir(dirName) {
    fs.mkdir(dirName, { recursive: true }, (err) => {
        if (err) throw err;
    });
}

/**
 * Get file name without extension
 *
 * @param {string} fileName file name with extension
 * @returns {string} file name without extension
 */
function getFileName(fileName) {
    return path.basename(fileName, path.extname(fileName));
}

/**
 * Create navigation in file
 *
 * @param {string} fileName Name of file to edit
 * @returns {string} Modified data with navigation
 */
function createNavigation(fileName) {
    return `<ul>${NAVIGATION.map((file) => {
        const name = getFileName(file);

        if (name === "index") {
            return `<li><a href="/">${CONFIG.defaultTitle}</a></li>`;
        }

        return `<li${
            name === fileName ? ' class="highlight"' : ""
        }><a href="/${encodeURIComponent(name)}/">${name}</a></li$>`;
    }).reduce((acc, cur) => acc + cur, "")}</ul>`;
}

/**
 * Create description of content
 *
 * @param {string} content
 * @returns {string} Description of content
 */
function getDescriptionFromContent(content) {
    const maxLength = 200;
    const contentForDescription = content
        .replace(/^<!--((.|\r?\n)*)-->$/gm, "")
        .replace(/"/gm, "&quot;")
        .replace(/<.+?>/gm, "")
        .replace(/(\r?\n)+/gm, " ")
        .trim();

    if (contentForDescription.length < maxLength) {
        return contentForDescription;
        ``;
    }

    return `${contentForDescription.slice(0, maxLength)}...`;
}

/**
 * Parse information of file with git and comments in file
 *
 * @param {RegExpMatchArray | null} regexMatchGroup
 * @param {string} fileName
 * @returns {{
 *      title: string;
 *      author: string;
 *      createdAt: string;
 *      modifiedAt: string;
 *      description: string;
 * }}
 */
function parseInfo(regexMatchGroup, fileName) {
    const { createdAt, modifiedAt } = TIMESTAMPS[fileName];
    const defaultValue = {
        title: getFileName(fileName),
        author: "",
        createdAt,
        modifiedAt,
        description: "",
    };

    if (!regexMatchGroup) {
        return defaultValue;
    }

    const [matchString] = regexMatchGroup;

    return {
        ...defaultValue,
        ...Object.fromEntries(
            matchString
                .replace(/(<!)?-->?/gm, "")
                .replace(/\r?\n/gm, "\n")
                .split("\n")
                .filter((x) => x !== "")
                .map((x) => x.split(":"))
                .map(([key, value]) => [key.trim(), value.trim()])
        ),
    };
}

/**
 * Add title for table of contents to file
 *
 * @param {string} data
 * @returns {string} Data with toc title
 */
function addTocTitleToData(data) {
    const h2Regex = /^## .+/gm;
    const [matchHeading] = data.match(h2Regex) || [];

    if (matchHeading) {
        return data.replace(
            matchHeading,
            `\n\n## Table of contents\n\n${matchHeading}\n\n`
        );
    }

    return `## Table of contents\n\n${data}`;
}

/**
 * Add navigation of previous / next post to file
 *
 * @param {string} data
 * @param {number} index Index of file
 * @returns {string}
 */
function addNavigationToData(data, index) {
    if (NAVIGATION.length <= 1) {
        return data;
    }

    const getArticleTag = (type, rawTitle) => {
        const title = getFileName(rawTitle);
        const isIndexFile = title === "index";
        const titleToDisplay = isIndexFile ? CONFIG.defaultTitle : title;
        const uri = isIndexFile ? "/" : `/${title}/`;

        return `<article class="navigation-item navigation-item--${type.toLowerCase()}"><a href="${uri}"><div><div class="navigation-item__type">${type}</div><h2 class="navigation-item__title">${titleToDisplay}</h2></div><div><i class="icon-arrow_${
            type === "Previous" ? "back" : "forward"
        }"></i></div></a></article>`;
    };

    if (index < 1) {
        return `${data}<div class="navigation">${getArticleTag(
            "Next",
            NAVIGATION[1]
        )}</div>`;
    }

    if (NAVIGATION.length - 1 <= index) {
        return `${data}<div class="navigation">${getArticleTag(
            "Previous",
            NAVIGATION[NAVIGATION.length - 2]
        )}</div>`;
    }

    return `${data}<div class="navigation">${getArticleTag(
        "Previous",
        NAVIGATION[index - 1]
    )}${getArticleTag("Next", NAVIGATION[index + 1])}</div>`;
}

/**
 * Create table of contents of file content
 *
 * @param {string} content
 * @returns {{
 *      content: string;
 *      toc: string;
 * }}
 */
function parseTocFromContent(content) {
    const lineBreakFormatted = content.replace(/\r?\n/gm, "\n");
    const contentArray = lineBreakFormatted.split("\n");
    const { length } = contentArray;
    let ulOpenedCnt = 0;
    let ulClosedCnt = 0;
    const startIndex = contentArray.indexOf(
        '<h2 id="table-of-contents">Table of contents</h2>'
    );
    let endIndex = 0;

    for (let i = startIndex; i <= length; i++) {
        const currentLine = contentArray[i];

        if (currentLine === "<ul>") {
            ulOpenedCnt++;
        }

        if (currentLine === "</ul>") {
            ulClosedCnt++;
        }

        if (0 < ulClosedCnt && ulOpenedCnt === ulClosedCnt) {
            endIndex = i + 1;
            break;
        }
    }

    return {
        content: `${contentArray.slice(0, startIndex).join("\n")}${contentArray
            .slice(endIndex)
            .join("\n")}`,
        toc: `<div class="toc-container"><ul class="toc">${contentArray
            .slice(startIndex + 2, endIndex)
            .join("")}</div>`,
    };
}

/**
 * Create file with option
 *
 * @param {{
 *  fileName: string;
 *  content: string;
 *  toc: string;
 *  info: {
 *      title: string;
 *      author: string;
 *      createdAt: string;
 *      modifiedAt: string;
 *      description: string;
 *  };
 * }} option
 */
function createFile({ fileName, content, toc, info }) {
    const { title, author, createdAt, modifiedAt, description } = info;
    const descriptionFromContent = getDescriptionFromContent(content);
    const templated = TEMPLATE.replace(/<!-- \[##_CONTENT_##] -->/gm, content)
        .replace(/<!-- \[##_TITLE_##] -->/gm, title)
        .replace(/<!-- \[##_SITE_NAME_##] -->/gm, CONFIG.defaultTitle)
        .replace(
            /<!-- \[##_DESCRIPTION_##] -->/gm,
            description || descriptionFromContent
        )
        .replace(/<!-- \[##_CREATED_AT_##] -->/gm, createdAt)
        .replace(/<!-- \[##_MODIFIED_AT_##] -->/gm, modifiedAt)
        .replace(/<!-- \[##_AUTHOR_##] -->/gm, author)
        .replace(/<!-- \[##_TOC_##] -->/gm, CONFIG.useToc ? toc : "")
        .replace(/<!-- \[##_NAVIGATION_##] -->/gm, createNavigation(fileName))
        .replace(/(src=|href=|url\()"\//g, `$1"${CONFIG.baseURL}`);

    if (fileName === "index") {
        fs.writeFileSync(path.resolve(OUTPUT_DIR, "index.html"), templated);
        return;
    }

    fs.writeFileSync(
        path.resolve(OUTPUT_DIR, getFileName(fileName), "index.html"),
        templated
    );
}

/**
 * Parse markdown and create html content
 *
 * @param {string} fileName
 * @param {index} index Index of file
 */
async function createHtmlOutputWithMd(fileName, index) {
    const commentsRegex = /^<!--((.|\r?\n)*)-->$/gm;
    const data = fs.readFileSync(path.resolve(DOCS_DIR, fileName), "utf-8");
    const parsed = `${await unified()
        .use(remarkParse)
        .use(remarkToc)
        .use(remarkRehype, { allowDangerousHtml: true })
        .use(rehypeSlug)
        .use(remarkGfm)
        .use(rehypeStringify, {
            allowDangerousCharacters: true,
            allowDangerousHtml: true,
        })
        .process(addTocTitleToData(data))}`;
    const navigationAdded = addNavigationToData(parsed, index);
    const { content, toc } = parseTocFromContent(navigationAdded);
    const nameWithoutExtension = getFileName(fileName);

    createFile({
        fileName: nameWithoutExtension,
        content,
        info: parseInfo(data.match(commentsRegex), fileName),
        toc,
    });
}

function main() {
    makeDir(OUTPUT_DIR);
    NAVIGATION.forEach((fileName) => {
        makeDir(path.resolve(OUTPUT_DIR, getFileName(fileName)));
    });
    NAVIGATION.forEach(createHtmlOutputWithMd);
}

main();
