const fs = require('fs')
const cheerio = require('cheerio')
const overrides = require('./inputs/overrides.json')

const QUOTE = '<|>'
const SATOSHI = 'Satoshi Nakamoto'
const BR = '<br/>'
const IGNORE_LINES = [SATOSHI, 'Satoshi', 'http://www.bitcoin.org']
const IGNORE_EMAIL = ['>>', 'From:', ' wrote:', ' writes:']
const IGNORE_POST = ['Greetings,', 'foobar', 'Posted:', 'Re: ', 'Regards,', '-------------']
// The rest are ignored
const ACCEPTED_UNICODES = ['0e3f', '00e9', '00e0', '00e8', '00e7']
const IS_CODE = /\b(const|char|\w+\.cpp|\w+\.h|getpid|addr|wxWidgets|ansi|htop|fprintf|stdout)\b/

const splitEmail = (email) => {
  if (!email) {
    return
  }
  let lines = email
    .replace(/> >/g, '>>')
    .split('\n')
    .map(l => l.trim())
  
  const sig = lines.indexOf('---------------------------------------------------------------------')
  if (sig !== -1) {
    const len = sig - 1
    while (lines[len] === '\n') {
      len--
    }
    // Remove their name too
    lines.length = len - 1
  }
  const out = []
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
  const emails = require('./inputs/emails.json')
  const out = []
  for (const email of emails) {
    if (email.sender !== SATOSHI) {
      continue
    }

    const [first, ...parts] = overrides[email.url]?.parts || splitEmail(email.text)
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

const splitPost = (html) => {
  const $ = cheerio.load(html)
  $('.quoteheader,.codeheader,img,del,.quote .quote').remove()
  $('br').replaceWith('\n')
  $('.code,a').each((_, e) => {
    $(e).replaceWith(e.childNodes)
  })
  $('.quote').each((_, e) => {
    $(e).text(QUOTE + $(e).text() + QUOTE)
  })
  return $.text()
    .replace(/EDIT: ?/g, '')
    // Clear a weird white-space
    .replace(/ /g, ' ')
    .replace(/  +/g, ' ')
    .replace(/\\u([a-z0-9]{4})/g, (_, code) => {
      if (!ACCEPTED_UNICODES.includes(code)) {
        return ''
      }
      // FIXME: There are 2 ocurrences of a \u0000ame replacement, now yields "ame" at the end
      return String.fromCharCode(parseInt(code, 16))
    })
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
  const posts = require('./inputs/posts.json')
  const out = []
  for (let i = 0; i < posts.length; i++) {
    const post = posts[i]
    if (!post.satoshi_id) {
      continue
    }
    if (post.content.startsWith('<div class=\"post\">--------------------<br/>')) {
      // Fix reposts from Satoshi, are not really his messages
      const parts = post.content.split(BR)
      post.content = parts[0].replace(/-+$/, '') + BR + parts.slice(4).join(BR)
      delete post.satoshi_id
      continue
    }
    
    const [first, ...parts] = overrides[post.url]?.parts || splitPost(post.content)
    if (first) {
      // Should be using nested_level for some, but seems like satoshi replied without nesting correctly (?)
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
      // It only happens with one where Satoshi puts a quote of himself as a response
      if (parts[j + 1]) {
        out.push({ date: post.date, src: post.url, q: parts[j], a: parts[j + 1] })
      }
    }
  }
  
  return out
}

const getType = (qa) => {
  // Ignore Q&A's that are too technical
  if (IS_CODE.test(qa.q + qa.a)) {
    // TODO: Ignore if too long?
    return 'ignore'
  }
}

const qas = parsePosts().concat(parseEmails())
  .map((qa) => ({
    ...qa, date: new Date(qa.date + ' UTC').toISOString().split('.')[0].replace('T', ' '), 
    type: overrides[qa.src]?.type || getType(qa),
  }))
  .sort((a, b) => a.date > b.date ? 1 : a.date < b.date ? -1 : 0)
  .map((qa, i) => ({ id: i + 1, ...qa }))
  .map(qa => ({ ...qa, qlen: qa.q.length, alen: qa.a.length }))
  .map(qa => ({ ...qa, len: qa.qlen + qa.alen }))

fs.writeFileSync('./data/qa.json', JSON.stringify(qas, null, '\t'))

const toHTML = (text) => {
  return text.replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, BR)
}

fs.writeFileSync('./data/qa.html', `
  <html>
  <head><title>Q&As of Satoshi Nakamoto</title></head>
  <body>
    ${qas.filter(qa => qa.type !== 'ignore').map(i => `
      <p><a id="${i.id}" href="#${i.id}">#${i.id}</a> - ${i.date} - <a href="${i.src}">${i.src}</a>${i.type == 'favorite' ? ' ⭐️' : ''}</p>
      <p><b>User</b>${i.qlen ? ` (${i.qlen} chars)`: ''}: ${toHTML(i.q)}</p>
      <p><b>Satoshi</b>${i.alen ? ` (${i.alen} chars)`: ''}: ${toHTML(i.a)}</p>
      <hr />
    `).join('')}
  </body>
  </html>
`)