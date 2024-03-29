import cheerio from 'cheerio'
import fs from 'fs'

import emails from './inputs/emails.json'
import overridesJson from './inputs/overrides.json'
import postsJson from './inputs/posts.json'

const QUOTE = '<|>'
const SATOSHI = 'Satoshi Nakamoto'
const BR = '<br/>'
const IGNORE_LINES = [SATOSHI, 'Satoshi', 'http://www.bitcoin.org']
const IGNORE_EMAIL = ['>>', 'From:', ' wrote:', ' writes:']
const IGNORE_POST = ['Greetings,', 'foobar', 'Posted:', 'Re: ', 'Regards,', '-------------']
// The rest are ignored
const ACCEPTED_UNICODES = ['0e3f', '00e9', '00e0', '00e8', '00e7']

interface QA {
  date: string
  src: string
  q: string
  a: string
}

interface Post {
  content: string
  date: string
  post_num: number
  satoshi_id?: number
  thread_id: number
  url: string
}

interface Override {
  parts?: string[]
  prev?: number
  type?: string
}

// Sadly these 2 don't get correctly inferred by the compiler
const posts = postsJson as Post[]
const overrides = overridesJson as Record<string, Override>

const splitEmail = (email: string | undefined) => {
  if (!email) {
    return
  }
  let lines = email
    .replace(/> >/g, '>>')
    .split('\n')
    .map(l => l.trim())

  const signature = lines.indexOf('---------------------------------------------------------------------')
  if (signature !== -1) {
    let len = signature - 1
    while (lines[len] === '\n') {
      len--
    }
    // Remove their name too
    lines.length = len - 1
  }
  const out: string[] = []
  let buf = ''
  let inQuote = false
  for (let line of lines) {
    if (!line || IGNORE_EMAIL.some(s => line.includes(s)) || /^[A-Z][A-Za-z. ]+:$/.test(line) || IGNORE_LINES.includes(line)) {
      continue
    }
    const isQuote = line.startsWith('>')
    if (isQuote !== inQuote) {
      inQuote = isQuote
      out.push(buf)
      buf = ''
    }
    if (isQuote) {
      line = line.slice(1)
    }
    if (!line) {
      // Empty quote lines are actually new lines
      buf += '\n\n'
    } else if (buf.slice(-1) === '.') {
      buf += '\n\n' + line
    } else {
      buf += ' ' + line
    }
  }
  if (buf) {
    out.push(buf)
  }

  return out.map(l => l.replace(/\n +/g, '\n').replace(/  +/g, ' ').trim())
}

const parseEmails = () => {
  const out: QA[] = []
  for (const email of emails) {
    if (email.sender !== SATOSHI) {
      continue
    }
    const [first, ...parts] = overrides[email.url]?.parts || splitEmail(email.text) || ''
    if (first) {
      const parent = overrides[email.url]?.prev || email.parent
      const prev = emails.find(p => p.id === parent && p.sender !== SATOSHI)
      const prevParts = prev && splitEmail(prev.text)
      if (prevParts) {
        const q = prevParts.pop() || prevParts[0]
        if (q) {
          parts.unshift(q.trim(), first)
        }
      }
    }
    for (let j = 0; j < parts.length; j += 2) {
      if (parts[j + 1]) {
        out.push({ date: email.date, src: email.url, q: parts[j], a: parts[j + 1] })
      }
    }
  }

  return out
}

const splitPost = (html: string) => {
  const $ = cheerio.load(html)
  $('.quoteheader,.codeheader,img,del,.quote .quote').remove()
  $('br').replaceWith('\n')
  $('.code,a').each((_, e) => {
    // Inline the text inside
    $(e).replaceWith(e.childNodes)
  })
  $('.quote').each((_, e) => {
    // Use a placeholder to retrieve quotes from the string later on
    $(e).text(QUOTE + $(e).text() + QUOTE)
  })
  return $.text()
    // Clear a weird white-space
    .replace(/ /g, ' ')
    .replace(/  +/g, ' ')
    .replace(/\\u([a-z0-9]{4})/g, (_, code) => {
      if (!ACCEPTED_UNICODES.includes(code)) {
        return ''
      }
      return String.fromCharCode(parseInt(code, 16))
    })
    // Unify apostrophes
    .replace(/`(s|t|ve|d)/g, '\'$1')
    // Remove EDITs
    .replace(/\bedit: ?|\[edit\]|\/edit/ig, '')
    .split('\n').map(p => p.trim()).filter(p =>
      !!p &&
      !IGNORE_LINES.includes(p) &&
      !IGNORE_POST.some(i => p.includes(i)) &&
      !/^[a-z-]+:$/i.test(p)
    ).join('\n')
    .split(QUOTE)
    .map(p => p.trim())
}

const parsePosts = () => {
  const out: QA[] = []
  for (const post of posts) {
    if (!post.satoshi_id) {
      continue
    }
    if (post.content.startsWith('<div class=\"post\">--------------------<br/>')) {
      // Fix reposts from Satoshi, they are someone else's message
      const parts = post.content.split(BR)
      post.content = parts[0].replace(/-+$/, '') + BR + parts.slice(4).join(BR)
      delete post.satoshi_id
      continue
    }

    const [first, ...parts] = overrides[post.url]?.parts || splitPost(post.content)
    if (first) {
      // Should be using nested_level for some, but seems like Satoshi replied without nesting correctly (?)
      // Example: https://p2pfoundation.ning.com/forum/topics/bitcoin-open-source?commentId=2003008%3AComment%3A9562
      const prevNum = overrides[post.url]?.prev ?? post.post_num - 1
      const prev = posts.find(p => !p.satoshi_id && p.thread_id === post.thread_id && p.post_num === prevNum)
      if (prev) {
        const prevParts = splitPost(prev.content)
        const q = prevParts.pop() || prevParts[0]
        if (q) {
          parts.unshift(q.trim(), first)
        }
      }
    }
    for (let j = 0; j < parts.length; j += 2) {
      // It only happens with one where Satoshi self-quotes as a response
      if (parts[j + 1]) {
        out.push({ date: post.date, src: post.url, q: parts[j], a: parts[j + 1] })
      }
    }
  }

  return out
}

const qas = parsePosts().concat(parseEmails())
  .map((qa) => ({
    type: overrides[qa.src]?.type, ...qa,
    date: new Date(qa.date + ' UTC').toISOString().split('.')[0].replace('T', ' '),
  }))
  .sort((a, b) => a.date > b.date ? 1 : a.date < b.date ? -1 : 0)
  .map((qa, i) => ({ id: i + 1, ...qa }))

fs.writeFileSync('./docs/qa.json', JSON.stringify(qas, null, '\t'))
