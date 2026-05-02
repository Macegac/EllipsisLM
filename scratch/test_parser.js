const keys = ['TITLE', 'CREATOR_NOTES', 'TAGS', 'SCENARIO_NAME', 'BRIEF_SUMMARY'];

function extractStructuredHeadings(text, keys) {
    const result = {};
    if (!text) return result;

    for (const key of keys) {
        const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const otherKeys = keys.filter(k => k !== key).join('|');
        const pattern = `(?:\\[|\\*\\*|#|\\n|^|\\s)*${escapedKey}(?:\\]|\\*\\*|\\:|\\s)*\\n([\\s\\S]*?)(?=\\n\\s*[\\[\\*#]*(${otherKeys})|$)`;
        const regex = new RegExp(pattern, 'i');
        
        const match = text.match(regex);
        if (match && match[1]) {
            result[key.toLowerCase()] = match[1].trim();
        } else {
            const fallbackRegex = new RegExp(`\\[?${escapedKey}\\]?\\s*\\n?([\\s\\S]*?)(?=\\n\\[|\\n#|\\n\\*\\*|$)`, 'i');
            const fallbackMatch = text.match(fallbackRegex);
            if (fallbackMatch) {
                result[key.toLowerCase()] = fallbackMatch[1].trim();
            } else {
                result[key.toLowerCase()] = ""; 
            }
        }
    }
    return result;
}

const testInput = `
Here is your story:
[TITLE]
Resilient Rabbit

CREATOR_NOTES]
This is where the brackets started failing.
But the text is still here.

[TAGS]
rabbit, warrior, fantasy

SCENARIO_NAME:
The Burrow's Edge

BRIEF_SUMMARY
The rabbit must save the carrot patch from the goblin king.
`;

const result = extractStructuredHeadings(testInput, keys);
console.log(JSON.stringify(result, null, 2));
