const fs = require('fs')
const cheerio = require('cheerio')

const QUOTE = '<|>'
const SATOSHI = 'Satoshi Nakamoto'
const IGNORE_LINES = [SATOSHI, 'http://www.bitcoin.org']
const IGNORE_EMAIL = ['>>', 'From:', ' wrote:', ' writes:']

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
    } else if (inQuote) {
      buf += ' ' + line
    } else {
      buf += '\n\n' + line
    }
  }
  if (buf) {
    out.push(buf)
  }

  return out.map(l => l.replace(/\n +/g, '\n').replace(/  +/g, ' ').trim())
}

const parseEmails = () => {
  const emails = require('./nakamotoinstitute.org/emails.json')
  const out = []
  for (const email of emails) {
    if (email.sender !== 'Satoshi Nakamoto') {
      continue
    }

    const [first, ...parts] = splitEmail(email.text)
    if (first) {
      const prev = emails.find(p => p.id === email.parent)
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
    // TEMP
    // if (out.length >= 2) {
    //   console.log(first, '\n\nPARTS: ', parts.join('\n\n'), '\n\nTEXT:', email.text)
    //   break
    // }
  }
  
  fs.writeFileSync('./data/emails.json', JSON.stringify(out, null, '\t'))
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
    .replace(/\\u\w+/g, '')
    .replace(/ /g, ' ').replace(/  +/g, ' ')
    .split('\n').map(p => p.trim()).filter(p =>
      !!p &&
      !p.includes('Posted:') &&
      !p.includes('-------------') &&
      !/^[a-z]+:$/.test(p) &&
      !IGNORE_LINES.includes(p)
    ).join('\n')
    .split(QUOTE)
    .map(p => p.trim())
}

const parsePosts = () => {
  const posts = require('./nakamotoinstitute.org/posts.json')
  const out = []
  for (let i = 0; i < posts.length; i++) {
    const post = posts[i]
    if (!post.satoshi_id) {
      continue
    }
    const [first, ...parts] = splitPost(post.content)
    if (first) {
      const prev = posts.find(p => p.thread_id === post.thread_id && p.nested_level === post.nested_level - 1)
      if (prev) {
        const prevParts = splitPost(prev.content)
        const q = prevParts.pop() || prevParts[0]
        if (q) {
          parts.unshift(q.trim(), first)
        }
      }
    }
    for (let j = 0; j < parts.length; j += 2) {
      if (parts[j + 1]) {
        out.push({ date: post.date, src: post.url, q: parts[j], a: parts[j + 1] })
      }
    }
  }
  
  fs.writeFileSync('./data/posts.json', JSON.stringify(out, null, '\t'))
  return out
}

const items = parsePosts().concat(parseEmails())
  .map(({ date, ...e }, id) => ({
    id, date: new Date(date + ' UTC').toISOString().split('.')[0].replace('T', ' '), ...e
  }))
  .sort((a, b) => a.date - b.date)
  .map(e => ({ ...e, qlen: e.q.length, alen: e.a.length }))
  .map(e => ({ ...e, len: e.qlen + e.alen }))

fs.writeFileSync('./data/all.json', JSON.stringify(items, null, '\t'))

const toHTML = (text) => {
  return text.replace(/\n/g, '<br />')
}

fs.writeFileSync('./data/all.html', `
  <html><head /><body><ul>
    ${items.map(i => `
      <li>
        <p>${i.date} - <a href="${i.src}">${i.src}</a></p>
        <p><b>User</b> (${i.qlen} chars): ${toHTML(i.q)}</p>
        <p><b>Satoshi</b> (${i.alen} chars): ${toHTML(i.a)}</p>
      </li>
    `).join('\n')}
  </ul></body></html>
`)