// ===== CONFIG =====
// DEVELOPER: Replace with your actual Groq API key
// API key is handled securely server-side via /api/groq

// ===== STATE =====
let documentText = '';
let documentChunks = [];
let documentText2 = '';
let documentChunks2 = [];
let chatHistory = [];
let isLoading = false;
let currentDocName = '';
let currentDocName2 = '';
let recognition = null;
let isListening = false;

pdfjsLib.GlobalWorkerOptions.workerSrc =
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

// ===== ON PAGE LOAD — restore saved chat =====
window.addEventListener('load', () => {
  // Version check — clear old broken data from previous builds
  const savedVersion = localStorage.getItem('legalai_version');
  if (savedVersion !== '4') {
    localStorage.removeItem('legalai_chat');
    localStorage.removeItem('legalai_docname');
    localStorage.removeItem('legalai_doctext');
    localStorage.removeItem('legalai_docchunks');
    localStorage.setItem('legalai_version', '4');
  }
  restoreChat();
  updateSendButton();
});

// ===== PERSIST CHAT + DOCUMENT TO LOCALSTORAGE =====
function saveChat() {
  try {
    localStorage.setItem('legalai_chat', JSON.stringify(chatHistory));
    localStorage.setItem('legalai_docname', currentDocName);
    // Save document text — split into chunks to avoid localStorage size limits
    if (documentText) {
      localStorage.setItem('legalai_doctext', documentText.substring(0, 400000)); // 400KB max
      localStorage.setItem('legalai_docchunks', JSON.stringify(documentChunks.slice(0, 500)));
    }
  } catch(e) {
    // If storage full, save chat only (doc text is largest)
    try {
      localStorage.setItem('legalai_chat', JSON.stringify(chatHistory));
      localStorage.setItem('legalai_docname', currentDocName);
    } catch(e2) {}
  }
}

function restoreChat() {
  try {
    const saved = localStorage.getItem('legalai_chat');
    const docname = localStorage.getItem('legalai_docname');
    const savedDocText = localStorage.getItem('legalai_doctext');
    const savedChunks = localStorage.getItem('legalai_docchunks');

    if (!saved) return;
    const history = JSON.parse(saved);
    if (!history || !Array.isArray(history) || history.length === 0) return;

    chatHistory = history;
    if (docname) currentDocName = docname;

    // Restore document text and chunks — enables new questions without re-uploading
    if (savedDocText && savedChunks) {
      documentText = savedDocText;
      documentChunks = JSON.parse(savedChunks);
      document.getElementById('docStatus').classList.remove('hidden');
      document.getElementById('docName').textContent = docname || 'Previously loaded document';
      document.getElementById('docStats').classList.remove('hidden');
      document.getElementById('chunkCount').textContent = documentChunks.length;
      document.getElementById('doc2-section').classList.remove('hidden');
      document.getElementById('uploadZone').innerHTML = `<div class="upload-icon">✅</div><p class="upload-text">${escapeHtml(docname || 'Document')}</p><p class="upload-hint">Restored from last session</p>`;
      ['btn-summarize','btn-checklist','btn-risks'].forEach(id => document.getElementById(id).disabled = false);
    } // end if (savedDocText && savedChunks)

    const container = document.getElementById('chatMessages');
    const welcome = container.querySelector('.welcome-message');
    if (welcome) welcome.remove();

    const docRestored = savedDocText && savedChunks;
    const notice = document.createElement('div');
    notice.className = 'message ai';
    notice.innerHTML = `<div class="msg-avatar">⚖️</div><div><div class="msg-content" style="background:#F0FDF4;border-color:#BBF7D0;font-size:13px">
      🔄 <strong>Session restored</strong> — ${Math.floor(history.length / 2)} question(s) from last visit.
      <br><span style="color:#065F46;font-size:12px">${docRestored ? '✅ Document also restored — you can ask new questions immediately!' : '⚠️ Please re-upload your document to ask new questions.'}</span>
      <button onclick="clearChat()" style="margin-left:10px;background:none;border:1px solid #059669;color:#065F46;border-radius:4px;padding:2px 8px;font-size:11px;cursor:pointer">🗑️ Clear & Start Fresh</button>
    </div></div>`;
    container.appendChild(notice);

    for (let i = 0; i < history.length; i++) {
      try {
        const msg = history[i];
        if (!msg || !msg.content) continue;
        if (msg.role === 'user') renderUserMessage(msg.content);
        else if (msg.role === 'assistant') renderAIMessage(msg.content, msg.suggestions || []);
      } catch(e) {
        console.warn('Skipped message during restore:', e);
      }
    }
    updateSendButton();
  } catch(e) {
    console.warn('Chat restore failed, clearing storage:', e);
    localStorage.removeItem('legalai_chat');
    localStorage.removeItem('legalai_docname');
    localStorage.removeItem('legalai_doctext');
    localStorage.removeItem('legalai_docchunks');
  }
}

// ===== PDF UPLOAD =====
const MAX_FILE_SIZE_MB = 50;
const MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024;

async function handleFileUpload(event) {
  const file = event.target.files[0];
  if (!file) return;
  const isSecond = event.target.id === 'fileInput2';
  validateAndProcessFile(file, isSecond);
}

function validateAndProcessFile(file, isSecond) {
  // File type check
  if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
    const ext = file.name.split('.').pop().toUpperCase();
    showFileError(`❌ "${file.name}" is a ${ext} file. Only PDF files are supported.\n\nPlease upload a PDF document (.pdf)`);
    return;
  }
  // File size check
  if (file.size > MAX_FILE_SIZE_BYTES) {
    const sizeMB = (file.size / (1024 * 1024)).toFixed(1);
    showFileError(`❌ File too large (${sizeMB}MB). Maximum allowed size is ${MAX_FILE_SIZE_MB}MB.\n\nTip: Try a smaller section of the document or compress the PDF.`);
    return;
  }
  processPDF(file, isSecond);
}

function showFileError(message) {
  const zone = document.getElementById('uploadZone');
  zone.innerHTML = `<div class="upload-icon">⚠️</div><p class="upload-text" style="color:#DC2626;font-size:12px">${message.replace(/\n/g,'<br>')}</p>`;
  setTimeout(() => {
    zone.innerHTML = '<div class="upload-icon">📂</div><p class="upload-text">Click or drag & drop PDF</p><p class="upload-hint">GST rules, IT Act, Compliance docs... (max 50MB)</p>';
  }, 4000);
  document.getElementById('fileInput').value = '';
}

const uploadZone = document.getElementById('uploadZone');
uploadZone.addEventListener('dragover', e => { e.preventDefault(); uploadZone.classList.add('drag-over'); });
uploadZone.addEventListener('dragleave', () => uploadZone.classList.remove('drag-over'));
uploadZone.addEventListener('drop', async e => {
  e.preventDefault(); uploadZone.classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  if (file) validateAndProcessFile(file, false);
});

async function processPDF(file, isSecond = false) {
  const zoneId = isSecond ? 'uploadZone2' : 'uploadZone';
  const zone = document.getElementById(zoneId);
  zone.innerHTML = '<div class="upload-icon">⏳</div><p class="upload-text">Reading PDF... 0%</p>';

  try {
    const arrayBuffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    const totalPages = pdf.numPages;

    let fullText = '';
    for (let i = 1; i <= totalPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      fullText += `\n[Page ${i}]\n` + content.items.map(item => item.str).join(' ');
      if (i % 50 === 0 || i === totalPages) {
        const pct = Math.round((i / totalPages) * 100);
        zone.innerHTML = `<div class="upload-icon">⏳</div><p class="upload-text">Extracting... ${pct}%</p><p class="upload-hint">${i} of ${totalPages} pages</p>`;
        await new Promise(r => setTimeout(r, 0));
      }
    } // end for loop
    const extractedText = fullText.trim();

    // ===== DOCUMENT VALIDATION — instant, no API call =====
    zone.innerHTML = '<div class="upload-icon">🔍</div><p class="upload-text">Validating document...</p>';
    await new Promise(r => setTimeout(r, 400)); // brief pause so user sees validation step
    const result = validateDocument(extractedText, file.name);
    console.log('[LegalAI] Validation score:', result.score, '| Valid:', result.valid, '| Text length:', extractedText.length);
    if (!result.valid) {
      if (isSecond) {
        zone.innerHTML = '<div class="upload-icon">📂</div><p class="upload-text">Click to upload 2nd PDF</p>';
        document.getElementById('fileInput2').value = '';
      } else {
        zone.innerHTML = '<div class="upload-icon">📂</div><p class="upload-text">Click or drag & drop PDF</p><p class="upload-hint">GST rules, IT Act, Compliance docs...</p>';
        document.getElementById('fileInput').value = '';
      }
      showDocumentRejection(file.name, result.score);
      return;
    } // end if (!result.valid)
    // ===== IMPROVED RAG: section-aware chunking =====
    const chunks = sectionAwareChunk(extractedText);

    zone.innerHTML = `<div class="upload-icon">✅</div><p class="upload-text">${file.name}</p><p class="upload-hint">${totalPages} pages loaded</p>`;

    if (isSecond) {
      documentText2 = extractedText;
      documentChunks2 = chunks;
      currentDocName2 = file.name;
      document.getElementById('docStatus2').classList.remove('hidden');
      document.getElementById('docName2').textContent = file.name;
      document.getElementById('btn-compare').disabled = false;
      addSystemMessage(`📄 Second document loaded: **${file.name}**\n${totalPages} pages · ${chunks.length} sections\n\nClick **Compare Both Documents** to see differences.`);
    } else {
      documentText = extractedText;
      documentChunks = chunks;
      currentDocName = file.name;
      document.getElementById('docStatus').classList.remove('hidden');
      document.getElementById('docName').textContent = file.name;
      document.getElementById('docStats').classList.remove('hidden');
      document.getElementById('chunkCount').textContent = chunks.length;
      document.getElementById('doc2-section').classList.remove('hidden');
      setTimeout(() => {
        document.getElementById('doc2-section').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        showToast('💡 Want to compare with another document? Upload a 2nd PDF above!', 4000);
      }, 800);
      ['btn-summarize','btn-checklist','btn-risks'].forEach(id => document.getElementById(id).disabled = false);
      updateSendButton();
      saveChat(); // persist doc text immediately
      addSystemMessage(`✅ Document validated and loaded: **${file.name}**\n${totalPages} pages · ${chunks.length} sections extracted\n\nYou can now ask questions about this document!`);
    }
  } catch (err) {
    console.error(err);
    zone.innerHTML = '<div class="upload-icon">❌</div><p class="upload-text">Error reading PDF. Try again.</p>';
  }
}

// ===== DOCUMENT VALIDATION — pure keyword scoring, no API call =====
function validateDocument(text, filename = '') {

  const filenameLower = filename.toLowerCase();
  const textLower = text.substring(0, 8000).toLowerCase(); // check first 8000 chars

  // HIGH-VALUE legal keywords (score 3 each) — these rarely appear in non-legal docs
  const highScore = [
    'gst','income tax','value added tax','stamp duty','customs duty','excise duty',
    'cbic','cbdt','sebi','rbi','rera','epfo','esic',
    'tax invoice','input tax credit','tax liability','tax assessment',
    'section 2','section 3','section 4','section 5','section 7','section 9',
    'sub-section','proviso','explanation','notification no','circular no',
    'gazette of india','official gazette','ministry of finance',
    'tribunal','high court','supreme court','adjudication','adjudicating authority',
    'assessee','taxable person','taxable supply','place of supply',
    'penalty clause','non-compliance','statutory obligation','regulatory',
    'ifrs','ind as','companies act','income tax act','gst act','customs act',
    'ibc','insolvency','liquidation','winding up'
  ];

  // MEDIUM-VALUE keywords (score 1 each)
  const medScore = [
    'section','clause','article','rule','act','regulation','compliance',
    'penalty','liability','provision','schedule','amendment','notification',
    'audit','finance','levy','assessment','appeal','enforcement',
    'statutory','jurisdiction','ordinance','enactment','legal','tax',
    'deduction','exemption','rebate','refund','return filing',
    'accounting','balance sheet','profit and loss','depreciation'
  ];

  // NEGATIVE keywords — strong signals this is NOT a legal/tax doc (score -3 each)
  const negScore = [
    'internship','contest','hackathon','project','submission','linkedin',
    'prize','winner','certificate','participant','team member',
    'machine learning','deep learning','neural network','dataset','model training',
    'resume','curriculum vitae','work experience','skills','education',
    'chapter 1','chapter 2','introduction to','study material','notes',
    'assignment','homework','question paper','exam','marks obtained'
  ];

  let score = 0;

  // Filename bonus — if filename clearly indicates legal doc, add 10
  const legalFilenames = ['gst','tax','act','law','legal','compliance','income','finance','audit','ifrs','vat','regulation','circular','cbic','cbdt','sebi','customs','excise','budget','tribunal','court','statute'];
  if (legalFilenames.some(kw => filenameLower.includes(kw))) score += 10;

  // Score the text
  highScore.forEach(kw => { if (textLower.includes(kw)) score += 3; });
  medScore.forEach(kw => {
    const matches = (textLower.match(new RegExp('\\b' + kw + '\\b', 'g')) || []).length;
    score += Math.min(matches, 4); // cap at 4 per word to avoid inflation
  });
  negScore.forEach(kw => { if (textLower.includes(kw)) score -= 3; });

  // If PDF has substantial text (>500 chars), accept it — real docs rarely score 0
  if (text.length > 500 && score >= 3) return { valid: true, score };
  // Strict check only for near-empty or clearly irrelevant files
  return { valid: score >= 8, score };
}

function showDocumentRejection(filename, score = 0) {
  const container = document.getElementById('chatMessages');
  const welcome = container.querySelector('.welcome-message');
  if (welcome) welcome.remove();

  const div = document.createElement('div');
  div.className = 'message ai';
  div.innerHTML = `
    <div class="msg-avatar">⚖️</div>
    <div>
      <div class="msg-content rejection-card">
        <div class="rejection-icon">🚫</div>
        <div class="rejection-title">Document Not Supported</div>
        <div class="rejection-body">
          <strong>"${escapeHtml(filename)}"</strong> does not appear to be a legal, tax, or compliance document.
          <br><br>
          This assistant only works with:
          <ul style="margin:8px 0 0 16px;line-height:1.8">
            <li>Tax documents (GST, Income Tax, VAT, Customs)</li>
            <li>Legal acts and regulations</li>
            <li>Compliance and audit documents</li>
            <li>Finance and accounting standards (IFRS, Ind AS)</li>
            <li>Government notifications and circulars</li>
          </ul>
          <br>
          Please upload a relevant legal or tax document to proceed.
        </div>
      </div>
    </div>`;
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
}

// ===== IMPROVED RAG: Section-aware chunking =====
function sectionAwareChunk(text) {
  const chunks = [];
  // Try to split on section/rule/clause boundaries first
  const sectionPattern = /(?=\[Page \d+\]|\bSection\s+\d+|\bRule\s+\d+|\bClause\s+\d+|\bArticle\s+\d+|\bChapter\s+[IVXLC\d]+)/gi;
  const parts = text.split(sectionPattern).filter(p => p.trim().length > 80);

  parts.forEach(part => {
    const words = part.trim().split(/\s+/);
    if (words.length <= 650) {
      chunks.push(part.trim());
    } else {
      // If section too long, split with overlap
      for (let i = 0; i < words.length; i += 540) {
        const chunk = words.slice(i, i + 600).join(' ');
        if (chunk.trim().length > 80) chunks.push(chunk.trim());
      }
    }
  });

  return chunks.length > 0 ? chunks : fallbackChunk(text);
}

function fallbackChunk(text) {
  const words = text.split(/\s+/);
  const chunks = [];
  for (let i = 0; i < words.length; i += 540) {
    const chunk = words.slice(i, i + 600).join(' ');
    if (chunk.trim().length > 80) chunks.push(chunk.trim());
  }
  return chunks;
}

// ===== RAG UPGRADE 1: Query expansion =====
function expandQuery(question) {
  const expansions = {
    'penalty': ['fine','punish','late fee','interest','offence','default'],
    'deadline': ['due date','time limit','last date','filing date','expiry'],
    'register': ['registration','enroll','enrolment','sign up'],
    'cancel': ['cancellation','revoke','revocation','suspend'],
    'refund': ['return','repayment','reimbursement','credit'],
    'invoice': ['bill','receipt','tax invoice','document'],
    'input tax credit': ['itc','input credit','credit','set off'],
    'return': ['filing','gstr','itr','submission','form'],
    'appeal': ['tribunal','court','dispute','objection','review'],
    'export': ['zero rated','overseas','foreign','outside india'],
    'exempt': ['exemption','nil rated','not liable','excluded'],
    'composition': ['compounding','small taxpayer','flat rate']
  };
  let expanded = question.toLowerCase();
  Object.entries(expansions).forEach(([key, synonyms]) => {
    if (expanded.includes(key)) {
      expanded += ' ' + synonyms.join(' ');
    }
  });
  return expanded;
}

// ===== RAG UPGRADE 2: TF-IDF + position boost + MMR diversity =====
function getRelevantChunks(question, chunks, maxChunks = 7) {
  if (!chunks || chunks.length === 0) return [];

  const stopWords = new Set(['what','are','the','is','in','of','to','and','a','an','for','this','that','how','do','does','can','will','with','from','on','at','by','be','has','have','which','when','where','who','all','any','was','were','been','its','it','i','me','my','please','tell','explain','give','show','list']);

  // Expand query with synonyms
  const expandedQ = expandQuery(question);
  const keywords = expandedQ
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .filter(w => w.length > 2 && !stopWords.has(w));

  if (keywords.length === 0) return chunks.slice(0, maxChunks);

  // Document frequency for IDF
  const df = {};
  keywords.forEach(kw => {
    df[kw] = chunks.filter(c => c.toLowerCase().includes(kw)).length || 1;
  });

  // Score every chunk
  const scored = chunks.map((chunk, i) => {
    const lower = chunk.toLowerCase();

    // TF-IDF base score
    let score = keywords.reduce((acc, kw) => {
      const tf = (lower.match(new RegExp(kw, 'g')) || []).length;
      const idf = Math.log((chunks.length + 1) / (df[kw] + 1));
      return acc + (tf * idf);
    }, 0);

    // Boost: exact phrase from original question
    const qWords = question.toLowerCase().split(/\s+/).filter(w => w.length > 3);
    const phrase2 = qWords.slice(0, 3).join(' ');
    const phrase3 = qWords.slice(0, 4).join(' ');
    if (phrase3.length > 5 && lower.includes(phrase3)) score += 5;
    if (phrase2.length > 5 && lower.includes(phrase2)) score += 3;

    // Boost: chunk contains section/rule headers (likely authoritative)
    if (/\bsection\s+\d+|\brule\s+\d+|\bclause\s+\d+/i.test(chunk)) score += 2;

    // Boost: chunk is from first 30% of doc (often contains definitions/key provisions)
    if (i < chunks.length * 0.3) score += 0.5;

    return { chunk, score, index: i };
  });

  // Sort by score
  const topScored = scored.sort((a, b) => b.score - a.score);

  // MMR (Maximal Marginal Relevance) — avoid redundant chunks
  // Pick chunks that are both relevant AND different from already selected ones
  const selected = [];
  const used = new Set();

  for (const item of topScored) {
    if (selected.length >= maxChunks) break;
    if (item.score <= 0) break;

    // Check similarity with already selected chunks — skip if too similar
    const itemWords = new Set(item.chunk.toLowerCase().split(/\s+/).filter(w => w.length > 4));
    let tooSimilar = false;

    for (const sel of selected) {
      const selWords = new Set(sel.chunk.toLowerCase().split(/\s+/).filter(w => w.length > 4));
      const intersection = [...itemWords].filter(w => selWords.has(w)).length;
      const union = new Set([...itemWords, ...selWords]).size;
      const jaccard = union > 0 ? intersection / union : 0;
      if (jaccard > 0.65) { tooSimilar = true; break; } // >65% overlap = skip
    } // end for sel
    if (!tooSimilar) selected.push(item);
  } // end for item

  // Restore document order for coherent context
  return selected
    .sort((a, b) => a.index - b.index)
    .map(c => c.chunk);
}

// ===== RAG SOURCE EXTRACTION — get page/section refs from chunks =====
function extractSources(chunks) {
  const sources = new Set();
  chunks.forEach(chunk => {
    // Extract [Page X] references
    const pageMatches = chunk.match(/\[Page (\d+)\]/gi) || [];
    pageMatches.forEach(m => sources.add(m));
    // Extract Section X references from text
    const sectionMatches = chunk.match(/\bSection\s+\d+[A-Z]?/gi) || [];
    sectionMatches.slice(0, 2).forEach(m => sources.add(m));
    // Extract Rule X references
    const ruleMatches = chunk.match(/\bRule\s+\d+[A-Z]?/gi) || [];
    ruleMatches.slice(0, 2).forEach(m => sources.add(m));
  });
  return [...sources].slice(0, 8); // max 8 source refs shown
}

function getConfidenceLevel(chunks, question) {
  if (chunks.length === 0) return { level: 'low', label: '🔴 Low', color: '#DC2626' };
  const keywords = question.toLowerCase().split(/\s+/).filter(w => w.length > 3);
  const matchingChunks = chunks.filter(c =>
    keywords.some(kw => c.toLowerCase().includes(kw))
  ).length;
  const ratio = matchingChunks / Math.max(chunks.length, 1);
  if (ratio >= 0.7 && chunks.length >= 4) return { level: 'high', label: '🟢 High', color: '#059669' };
  if (ratio >= 0.4 || chunks.length >= 3) return { level: 'medium', label: '🟡 Medium', color: '#D97706' };
  return { level: 'low', label: '🔴 Low', color: '#DC2626' };
}
async function callGroq(systemPrompt, userMessage, context = '', retryCount = 0) {
  const messages = [];
  // Memory: include last 6 messages (3 pairs)
  chatHistory.slice(-6).forEach(m => messages.push({ role: m.role, content: m.content }));

  if (context) {
    messages.push({ role: 'user', content: `Document context:\n\n---\n${context}\n---\n\nQuestion: ${userMessage}` });
  } else {
    messages.push({ role: 'user', content: userMessage });
  }

  const response = await fetch('/api/groq', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemPrompt,
      messages,
      model: 'llama-3.3-70b-versatile',
      max_tokens: 1024,
      temperature: 0.3
    })
  });

  if (response.status === 429) {
    if (retryCount < 3) {
      const wait = (retryCount + 1) * 3;
      showRetryToast(wait);
      await new Promise(r => setTimeout(r, wait * 1000));
      hideRetryToast();
      return callGroq(systemPrompt, userMessage, context, retryCount + 1);
    }
    throw new Error('RATE_LIMIT');
  }
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    const errMsg = err.error?.message || 'API_ERROR';
    console.error('[Groq API Error]', response.status, errMsg);
    throw new Error(errMsg);
  }
  const data = await response.json();
  return data.choices[0].message.content;
}

// ===== SECURITY: Input sanitization + prompt injection guard =====
function sanitizeInput(text) {
  if (!text || typeof text !== 'string') return '';

  // Length limit — prevent context overflow attacks
  if (text.length > 2000) {
    text = text.substring(0, 2000) + '...';
  }

  // Prompt injection patterns — detect attempts to override system instructions
  const injectionPatterns = [
    /ignore\s+(all\s+)?(previous|above|prior)\s+instructions/i,
    /forget\s+(everything|all|your\s+instructions)/i,
    /you\s+are\s+now\s+a\s+different/i,
    /act\s+as\s+(if\s+you\s+are|a\s+different|an?\s+unrestricted)/i,
    /jailbreak|dan\s+mode|developer\s+mode|unrestricted\s+mode/i,
    /bypass\s+(safety|filter|restriction|guideline)/i,
    /disregard\s+(your|all)\s+(rule|instruction|guideline)/i,
    /\[system\]|\[admin\]|\[override\]|\[prompt\]/i,
    /reveal\s+(your\s+)?(system\s+prompt|api\s+key|secret|password)/i,
    /print\s+(your\s+)?(system\s+prompt|instructions|api\s+key)/i
  ];

  const detected = injectionPatterns.some(p => p.test(text));
  if (detected) {
    return '__INJECTION_DETECTED__';
  }

  // Remove null bytes and control characters
  return text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '').trim();
}

// ===== SECURITY: Client-side rate limiting =====
const requestLog = [];
function checkRateLimit() {
  const now = Date.now();
  // Remove entries older than 60 seconds
  const recent = requestLog.filter(t => now - t < 60000);
  requestLog.length = 0;
  requestLog.push(...recent);

  if (requestLog.length >= 8) {
    return false; // max 8 requests per minute
  }
  requestLog.push(now);
  return true;
}

// ===== OFF-TOPIC GUARD: detect greetings / unrelated questions =====
// ===== OFF-TOPIC GUARD =====
// Returns a category string or null if it's a document question
function classifyInput(text) {
  const t = text.toLowerCase().trim();

  if (/^(hi|hello|hey|howdy|hiya|greetings)[\s!?.]*$/.test(t)) return 'hello';
  if (/^good\s*(morning)[\s!?.]*$/.test(t)) return 'good_morning';
  if (/^good\s*(afternoon)[\s!?.]*$/.test(t)) return 'good_afternoon';
  if (/^good\s*(evening|night)[\s!?.]*$/.test(t)) return 'good_evening';
  if (/^(how are you|how do you do|how r u|how r you)[\s!?.]*$/.test(t)) return 'how_are_you';
  if (/^(thank(s| you|u)|thanks a lot|thank you so much)[\s!?.]*$/.test(t)) return 'thanks';
  if (/^(bye|goodbye|see you|see ya|later|ttyl|take care)[\s!?.]*$/.test(t)) return 'bye';
  if (/^(who are you|what are you|are you an? ai|are you (a )?bot|what can you do|tell me about yourself)[\s!?.]*$/.test(t)) return 'who_are_you';
  if (/^(ok|okay|got it|alright|sure|noted|i see|i understand|understood)[\s!?.]*$/.test(t)) return 'acknowledgement';
  if (/^(what's up|whats up|sup|yo|wassup)[\s!?.]*$/.test(t)) return 'casual';
  if (/^(wow|cool|nice|great|awesome|amazing|excellent|perfect|fantastic)[\s!?.]*$/.test(t)) return 'positive_reaction';
  if (/^(no|nope|nah|not really|not now)[\s!?.]*$/.test(t)) return 'negative';

  // Short messages with no legal keywords = off-topic
  if (t.split(/\s+/).length <= 4) {
    const legalHint = /tax|law|gst|act|section|clause|rule|penalty|compliance|legal|audit|document|filing|provision|regulation|return|income|finance|court|contract/i;
    if (!legalHint.test(t)) return 'generic_offtopic';
  }

  return null; // it's a real document question
}

const docName = () => currentDocName ? `"${currentDocName}"` : 'your uploaded document';

const offTopicReplies = {
  hello: () => `Hello! 👋 Great to have you here.\n\nI'm ready to help you analyze ${docName()}. Feel free to ask anything — like what penalties are mentioned, filing deadlines, or key compliance obligations!`,
  good_morning: () => `Good morning! ☀️ Hope you're having a great start to the day.\n\nWhenever you're ready, I can help you dive into ${docName()} — summaries, risk flags, compliance checklists, you name it!`,
  good_afternoon: () => `Good afternoon! 🌤️ Happy to help you power through your research.\n\nJust ask me anything about ${docName()} — key provisions, deadlines, penalties, or a full summary.`,
  good_evening: () => `Good evening! 🌙 Working late? I've got you covered.\n\nAsk me anything about ${docName()} and I'll pull out the relevant sections right away.`,
  how_are_you: () => `I'm doing great, thanks for asking! 😊 Ready to dig into some legal research.\n\nWhat would you like to know about ${docName()}?`,
  thanks: () => `You're welcome! 😊 Happy to help.\n\nFeel free to ask anything else about ${docName()}.`,
  bye: () => `Goodbye! 👋 Come back anytime you need help with legal or tax document research.\n\nYour document ${docName()} will be ready when you return!`,
  who_are_you: () => `I'm your **AI Legal & Tax Research Assistant** ⚖️\n\nI specialize in analyzing legal and tax documents. Upload a PDF and I can:\n- 📋 Summarize key sections\n- 🚨 Flag risks and penalties\n- ✅ Generate compliance checklists\n- 🔀 Compare two documents side by side\n\nCurrently loaded: ${docName()}. What would you like to know?`,
  acknowledgement: () => `Got it! 👍 Let me know whenever you have a question about ${docName()}.`,
  casual: () => `Not much — just ready to help you with ${docName()}! 😄 What do you want to know?`,
  positive_reaction: () => `Glad you think so! 😊 Let's keep going — what else would you like to know about ${docName()}?`,
  negative: () => `No worries! Just let me know whenever you have a question about ${docName()}.`,
  generic_offtopic: () => `I'm your **Legal & Tax Research Assistant** — I'm best at answering questions about ${docName()}.\n\nTry asking something like:\n- What are the key obligations?\n- What penalties are mentioned?\n- What are the filing deadlines?`
};

function showOffTopicReply(category) {
  const replyFn = offTopicReplies[category] || offTopicReplies['generic_offtopic'];
  const typingId = addTypingIndicator();
  setTimeout(() => {
    removeTypingIndicator(typingId);
    renderAIMessage(replyFn());
  }, 500);
}
async function askQuestion() {
  const rawQuestion = document.getElementById('questionInput').value.trim();
  if (!rawQuestion || isLoading) return;
  if (!documentText) { showToast('📄 Please upload a document first — then ask your question.', 3000); document.getElementById('uploadZone').style.cssText = 'border: 2px solid #7C3AED'; setTimeout(() => document.getElementById('uploadZone').style.cssText = '', 2000); return; }

  // Security checks
  if (!checkRateLimit()) {
    showToast('⏳ Too many requests. Please wait a moment before asking again.', 4000);
    return;
  }

  const question = sanitizeInput(rawQuestion);
  if (question === '__INJECTION_DETECTED__') {
    renderUserMessage(rawQuestion);
    renderAIMessage('⚠️ **Invalid input detected.** Please ask a genuine question about the legal document.');
    document.getElementById('questionInput').value = '';
    return;
  }

  // Off-topic / greeting guard — before any API call
  const inputCategory = classifyInput(question);
  if (inputCategory) {
    renderUserMessage(question);
    document.getElementById('questionInput').value = '';
    updateCharCount();
    showOffTopicReply(inputCategory);
    return;
  }

  renderUserMessage(question);
  document.getElementById('questionInput').value = '';
  updateCharCount();

  const typingId = addTypingIndicator();
  isLoading = true;
  updateSendButton();

  try {
    const chunks = getRelevantChunks(question, documentChunks);
    const context = chunks.join('\n\n---\n\n').substring(0, 8000); // trim to avoid token limit
    const sources = extractSources(chunks);
    const confidence = getConfidenceLevel(chunks, question);

    const systemPrompt = `You are an expert AI Legal and Tax Research Assistant. You help users understand legal, tax, and compliance documents through RAG (Retrieval-Augmented Generation).

DOCUMENT CONTEXT: You have been provided with relevant sections retrieved from the uploaded document.

STRICT RULES:
1. ONLY answer questions about the uploaded legal/tax document. If the user asks anything unrelated to legal, tax, compliance, or the uploaded document (e.g. greetings, general knowledge, personal questions), respond ONLY with: "I can only help with questions about the uploaded legal or tax document. Please ask something related to it."
2. ONLY answer based on the provided document context. Never use general knowledge as the primary answer.
3. Always cite using exact format: [Section X], [Rule X], [Page X], [Clause X]
4. If the answer is not in the provided context, say clearly: "This specific information was not found in the retrieved sections. Try rephrasing or asking about a specific section."
5. Structure answers with: Direct Answer → Supporting Details → Relevant Sections
6. For penalties/deadlines: always state the exact amount or date if available in context
7. Never make up section numbers. Only cite what appears in the context.
8. Keep answers focused and under 400 words unless a detailed summary is requested.
9. End your response with exactly: SUGGEST:question1|question2|question3`;

    const answer = await callGroq(systemPrompt, question, context);
    const parts = answer.split('SUGGEST:');
    const cleanAnswer = parts[0].trim();
    const suggestions = parts[1] ? parts[1].split('|').map(s => sanitizeInput(s.trim())).filter(s => s && s !== '__INJECTION_DETECTED__').slice(0, 3) : [];

    removeTypingIndicator(typingId);
    renderAIMessage(cleanAnswer, suggestions, question, sources, confidence);

    chatHistory.push({ role: 'user', content: question });
    chatHistory.push({ role: 'assistant', content: cleanAnswer, suggestions: suggestions });
    if (chatHistory.length > 10) chatHistory = chatHistory.slice(-10);
    saveChat();

  } catch (err) {
    removeTypingIndicator(typingId);
    renderAIMessage(getFriendlyError(err.message), []);
  } finally {
    isLoading = false;
    updateSendButton();
  }
}

// ===== QUICK ACTIONS =====
async function runAction(type) {
  if (!documentText) { showToast('📄 Please upload a document first — then ask your question.', 3000); document.getElementById('uploadZone').style.cssText = 'border: 2px solid #7C3AED'; setTimeout(() => document.getElementById('uploadZone').style.cssText = '', 2000); return; }
  if (isLoading) return;

  const actions = {
    summarize: {
      prompt: `You are a legal document summarizer. Give a structured summary with clear headers:
1. Document Overview
2. Key Sections and their purpose
3. Main obligations
4. Important dates or deadlines
5. Key definitions
Cite section numbers wherever possible.`,
      question: 'Please provide a comprehensive section-wise summary of this document.'
    },
    checklist: {
      prompt: `You are a compliance expert. Generate a practical compliance checklist.
Each item must start with [ ], be actionable, have a section reference in brackets, and mention deadlines if applicable.
Group by category: Filing Requirements, Payment Obligations, Documentation, etc.`,
      question: 'Generate a comprehensive compliance checklist from this document.'
    },
    risks: {
      prompt: `You are a risk assessment expert. Identify and categorize all risks in this document.
Use exactly this format for each item:
🔴 HIGH RISK: [Description] - [Section]
🟡 MEDIUM RISK: [Description] - [Section]
🟢 NOTE: [Description] - [Section]
Focus on: penalties, fines, deadlines, non-compliance consequences, ambiguous clauses.`,
      question: 'Identify all risk flags, penalties, and critical compliance points in this document.'
    },
    compare: {
      prompt: `You are a legal document comparison expert. Compare the two documents provided.
Structure:
1. KEY DIFFERENCES — what changed
2. NEW PROVISIONS — in doc2 but not doc1
3. REMOVED PROVISIONS — in doc1 but not doc2
4. SIMILAR PROVISIONS — unchanged
Cite section references from both documents.`,
      question: `Compare: "${currentDocName}" vs "${currentDocName2}"`
    }
  };

  const action = actions[type];
  const btn = document.getElementById('btn-' + type);
  const originalText = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Processing...'; }

  renderUserMessage(action.question);
  const typingId = addTypingIndicator();
  isLoading = true;
  updateSendButton();

  try {
    let context;
    if (type === 'compare') {
      context = `DOCUMENT 1 — ${currentDocName}:\n${documentChunks.slice(0, 12).join('\n\n')}\n\n========\n\nDOCUMENT 2 — ${currentDocName2}:\n${documentChunks2.slice(0, 12).join('\n\n')}`;
    } else {
      context = documentChunks.join('\n\n').substring(0, 14000);
    }
    const answer = await callGroq(action.prompt, action.question, context);
    const cleanAnswer = answer.split('SUGGEST:')[0].trim();

    removeTypingIndicator(typingId);
    if (type === 'checklist') {
      renderChecklistMessage(cleanAnswer);
    } else {
      renderAIMessage(cleanAnswer, [], action.question);
    }
    chatHistory.push({ role: 'user', content: action.question });
    chatHistory.push({ role: 'assistant', content: cleanAnswer });
    saveChat();

  } catch (err) {
    removeTypingIndicator(typingId);
    renderAIMessage(getFriendlyError(err.message), []);
  } finally {
    isLoading = false;
    updateSendButton();
    if (btn) { btn.disabled = false; btn.textContent = originalText; }
  }
}

// ===== RENDER FUNCTIONS =====
function renderUserMessage(text) {
  const div = document.createElement('div');
  div.className = 'message user';
  div.innerHTML = `<div class="msg-avatar">👤</div><div><div class="msg-content">${escapeHtml(text)}</div></div>`;
  appendMessage(div);
}

function renderAIMessage(text, suggestions = [], questionText = '', sources = [], confidence = null) {
  const formatted = formatAIResponse(text);
  const safeText = escapeForAttr(text || '');
  const safeQuestion = escapeForAttr(questionText || '');

  const suggestHTML = suggestions.length ? `
    <div class="suggestions">
      ${suggestions.map(s => `<button class="suggest-chip" onclick="useSuggestion(this)">${escapeHtml(s)}</button>`).join('')}
    </div>` : '';

  // RAG Sources panel
  const sourcesHTML = sources.length ? `
    <div class="rag-sources">
      <span class="rag-sources-label">📚 RAG Sources:</span>
      ${sources.map(s => `<span class="source-chip">${escapeHtml(s)}</span>`).join('')}
      ${confidence ? `<span class="confidence-chip" style="color:${confidence.color};border-color:${confidence.color}20;background:${confidence.color}10">Confidence: ${confidence.label}</span>` : ''}
    </div>` : '';

  const div = document.createElement('div');
  div.className = 'message ai';
  div.innerHTML = `
    <div class="msg-avatar">⚖️</div>
    <div style="flex:1;min-width:0">
      <div class="msg-content">${formatted}</div>
      ${sourcesHTML}
      ${suggestHTML}
      <div class="msg-actions">
        <button class="msg-action-btn" onclick="copyMsg(this, \`${safeText}\`)">📋 Copy</button>
        <button class="msg-action-btn" onclick="downloadAnswer(this, \`${safeQuestion}\`, \`${safeText}\`)">⬇️ Save Answer</button>
      </div>
    </div>`;
  appendMessage(div);
}

function renderChecklistMessage(text) {
  const lines = text.split('\n').filter(l => l.trim());
  let html = '<div style="font-weight:600;margin-bottom:10px;color:#5B21B6">✅ Compliance Checklist</div>';
  lines.forEach((line, i) => {
    const clean = line.replace(/^\[\s*\]\s*/, '').replace(/^\d+\.\s*/, '').trim();
    if (clean.length > 3) {
      html += `<div class="checklist-item"><input type="checkbox" id="chk${i}"><label for="chk${i}">${formatAIResponse(clean)}</label></div>`;
    }
  });

  const div = document.createElement('div');
  div.className = 'message ai';
  div.innerHTML = `
    <div class="msg-avatar">⚖️</div>
    <div style="flex:1;min-width:0">
      <div class="msg-content">${html}</div>
      <div class="msg-actions">
        <button class="msg-action-btn" onclick="copyMsg(this, \`${escapeForAttr(text)}\`)">📋 Copy</button>
        <button class="msg-action-btn" onclick="downloadAnswer(this, 'Compliance Checklist', \`${escapeForAttr(text)}\`)">⬇️ Save Answer</button>
      </div>
    </div>`;
  appendMessage(div);
}

function addSystemMessage(text) {
  const formatted = text.replace(/\*\*(.*?)\*\*/g,'<strong>$1</strong>').replace(/\n/g,'<br>');
  const div = document.createElement('div');
  div.className = 'message ai';
  div.innerHTML = `<div class="msg-avatar">⚖️</div><div><div class="msg-content" style="background:#F0FDF4;border-color:#BBF7D0">${formatted}</div></div>`;
  appendMessage(div);
}

function addTypingIndicator() {
  const id = 'typing-' + Date.now();
  const div = document.createElement('div');
  div.className = 'message ai typing-indicator';
  div.id = id;
  div.innerHTML = `<div class="msg-avatar">⚖️</div><div><div class="msg-content" style="display:flex;gap:5px;align-items:center;padding:14px 18px"><div class="typing-dot"></div><div class="typing-dot"></div><div class="typing-dot"></div></div></div>`;
  appendMessage(div);
  return id;
}

function removeTypingIndicator(id) {
  const el = document.getElementById(id);
  if (el) el.remove();
}

function appendMessage(div) {
  const container = document.getElementById('chatMessages');
  const welcome = container.querySelector('.welcome-message');
  if (welcome) welcome.remove();
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
}

function useSuggestion(btn) {
  document.getElementById('questionInput').value = btn.textContent;
  document.getElementById('questionInput').focus();
  updateCharCount();
}

// ===== PER-ANSWER DOWNLOAD =====
function downloadAnswer(btn, question, answer) {
  const content = question
    ? `Question:\n${question}\n\n${'─'.repeat(40)}\n\nAnswer:\n${answer}\n\n─────────────────────────────\nDocument: ${currentDocName}\nDate: ${new Date().toLocaleString()}\nAI Legal / Tax Research Assistant — For research support only`
    : `${answer}\n\nDocument: ${currentDocName}\nDate: ${new Date().toLocaleString()}`;

  const blob = new Blob([content], { type: 'text/plain' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `answer-${Date.now()}.txt`;
  a.click();
  URL.revokeObjectURL(a.href);
  btn.textContent = '✅ Saved!';
  setTimeout(() => btn.textContent = '⬇️ Save Answer', 2000);
}

// ===== FORMATTING =====
function formatAIResponse(text) {
  return text
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/\[(Section|Page|Clause|Article|Rule|Para|Schedule|Chapter|Annexure)\s*[\d.A-Za-z,\s]+\]/gi,
      '<span class="citation">$&</span>')
    .replace(/🔴\s*HIGH RISK:(.*?)(?=\n🔴|\n🟡|\n🟢|$)/gs,
      '<div class="risk-card risk-high">🔴 <strong>HIGH RISK:</strong>$1</div>')
    .replace(/🟡\s*MEDIUM RISK:(.*?)(?=\n🔴|\n🟡|\n🟢|$)/gs,
      '<div class="risk-card risk-medium">🟡 <strong>MEDIUM RISK:</strong>$1</div>')
    .replace(/🟢\s*NOTE:(.*?)(?=\n🔴|\n🟡|\n🟢|$)/gs,
      '<div class="risk-card risk-low">🟢 <strong>NOTE:</strong>$1</div>')
    .replace(/^#{1,3}\s+(.+)$/gm, '<strong style="display:block;margin:10px 0 4px;color:#374151;font-size:14px">$1</strong>')
    .replace(/^[\s]*[-•]\s+(.+)$/gm, '<li style="margin:3px 0">$1</li>')
    .replace(/\n\n/g, '</p><p style="margin-top:8px">')
    .replace(/\n/g, '<br>');
}

function escapeHtml(t) {
  if (!t) return '';
  return t.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function escapeForAttr(t) {
  if (!t) return '';
  return t.replace(/\\/g,'\\\\').replace(/`/g,'\\`').replace(/\$/g,'\\$');
}

// ===== EXPORT FULL REPORT =====
function exportReport() {
  if (chatHistory.length === 0) { showToast('💬 No chat to export yet. Ask a question first!'); return; }
  const rows = chatHistory.map(m => {
    return m.role === 'user'
      ? `<div style="background:#7C3AED;color:white;padding:10px 14px;border-radius:8px;margin:8px 0;font-size:13px"><strong>👤 You:</strong> ${escapeHtml(m.content)}</div>`
      : `<div style="border:1px solid #E5E7EB;padding:10px 14px;border-radius:8px;margin:8px 0;font-size:13px"><strong>⚖️ Assistant:</strong><br>${formatAIResponse(m.content)}</div>`;
  }).join('');

  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Legal Research Report</title>
<style>body{font-family:system-ui,sans-serif;max-width:800px;margin:40px auto;padding:0 20px;color:#1F2937}
h1{color:#7C3AED;border-bottom:2px solid #EDE9FE;padding-bottom:10px}
.citation{background:#EDE9FE;color:#5B21B6;padding:1px 6px;border-radius:4px;font-size:12px;font-weight:600}
.risk-high{background:#FEE2E2;border-left:4px solid #DC2626;padding:8px 12px;margin:6px 0;border-radius:4px}
.risk-medium{background:#FEF3C7;border-left:4px solid #D97706;padding:8px 12px;margin:6px 0;border-radius:4px}
.risk-low{background:#D1FAE5;border-left:4px solid #059669;padding:8px 12px;margin:6px 0;border-radius:4px}
footer{margin-top:40px;padding-top:16px;border-top:1px solid #E5E7EB;font-size:12px;color:#9CA3AF}
</style></head><body>
<h1>⚖️ Legal / Tax Research Report</h1>
<p style="color:#6B7280;font-size:13px">Document: <strong>${escapeHtml(currentDocName)}</strong> · Generated: ${new Date().toLocaleString()}</p>
<hr style="margin:16px 0;border-color:#E5E7EB">
${rows}
<footer>Generated by AI Legal / Tax Research Assistant · For research support only · Not legal advice</footer>
</body></html>`;

  const blob = new Blob([html], { type: 'text/html' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
  a.download = `legal-report-${Date.now()}.html`; a.click();
  URL.revokeObjectURL(a.href);
  showToast('📄 Full report downloaded!');
}

function exportChat() {
  if (chatHistory.length === 0) { showToast('💬 No chat to export yet.'); return; }
  let text = `AI Legal / Tax Research Report\nDocument: ${currentDocName}\nDate: ${new Date().toLocaleString()}\n${'═'.repeat(50)}\n\n`;
  chatHistory.forEach(m => {
    text += `${m.role === 'user' ? '👤 YOU' : '⚖️ ASSISTANT'}:\n${m.content}\n\n${'─'.repeat(50)}\n\n`;
  });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  a.download = `legal-chat-${Date.now()}.txt`; a.click();
  URL.revokeObjectURL(a.href);
  showToast('📝 Chat exported as .txt!');
}

function clearChat() {
  if (chatHistory.length > 0 && !confirm('Clear all chat messages and history?')) return;
  chatHistory = [];
  localStorage.removeItem('legalai_chat');
  localStorage.removeItem('legalai_docname');
  localStorage.removeItem('legalai_doctext');
  localStorage.removeItem('legalai_docchunks');
  document.getElementById('chatMessages').innerHTML = `
    <div class="welcome-message">
      <div class="welcome-icon">⚖️</div>
      <h2>Chat cleared</h2>
      <p>Upload a document and start asking questions.</p>
      <div class="welcome-features">
        <span class="feature-chip">📎 Document Q&A</span>
        <span class="feature-chip">📋 Compliance Checklist</span>
        <span class="feature-chip">🚨 Risk Flag Detection</span>
        <span class="feature-chip">🔀 Document Comparison</span>
      </div>
    </div>`;
}

// ===== TOAST =====
function showRetryToast(seconds) {
  let toast = document.getElementById('retry-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'retry-toast';
    toast.style.cssText = 'position:fixed;bottom:80px;left:50%;transform:translateX(-50%);background:#1F2937;color:white;padding:12px 20px;border-radius:10px;font-size:13px;z-index:999;display:flex;align-items:center;gap:10px;box-shadow:0 4px 12px rgba(0,0,0,0.2)';
    document.body.appendChild(toast);
  }
  let r = seconds;
  toast.innerHTML = `⏳ Too many requests. Auto-retrying in <strong id="retry-count">${r}s</strong>...`;
  toast.style.display = 'flex';
  const iv = setInterval(() => { r--; const el = document.getElementById('retry-count'); if(el) el.textContent=r+'s'; if(r<=0) clearInterval(iv); }, 1000);
}
function hideRetryToast() { const t = document.getElementById('retry-toast'); if(t) t.style.display='none'; }

function showToast(message, duration = 3000) {
  let toast = document.getElementById('general-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'general-toast';
    toast.style.cssText = 'position:fixed;bottom:80px;left:50%;transform:translateX(-50%);background:#1F2937;color:white;padding:12px 22px;border-radius:10px;font-size:13px;z-index:998;box-shadow:0 4px 12px rgba(0,0,0,0.2);max-width:420px;text-align:center;transition:opacity 0.3s';
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.style.opacity = '1'; toast.style.display = 'block';
  setTimeout(() => { toast.style.opacity='0'; setTimeout(()=>toast.style.display='none',300); }, duration);
}

// ===== VOICE INPUT =====
function toggleVoice() {
  if (!('webkitSpeechRecognition' in window) && !('SpeechRecognition' in window)) {
    showToast('🎤 Voice input is not supported in this browser. Please use Chrome.', 4000);
    return;
  }

  if (isListening) {
    stopVoice();
    return;
  }

  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  recognition = new SpeechRecognition();

  recognition.lang = 'en-IN';
  recognition.continuous = false;
  recognition.interimResults = true;
  recognition.maxAlternatives = 1;

  recognition.onstart = () => {
    isListening = true;
    const micBtn = document.getElementById('micBtn');
    const micStatus = document.getElementById('micStatus');
    if (micBtn) { micBtn.classList.add('listening'); micBtn.title = 'Click to stop'; micBtn.textContent = '⏹️'; }
    if (micStatus) micStatus.classList.remove('hidden');
  };

  recognition.onresult = (event) => {
    const transcript = Array.from(event.results)
      .map(r => r[0].transcript).join('');
    const input = document.getElementById('questionInput');
    if (input) { input.value = transcript; updateCharCount(); }
  };

  recognition.onerror = (event) => {
    stopVoice();
    if (event.error === 'not-allowed') {
      showToast('🎤 Microphone access denied. Please allow microphone permission.', 4000);
    } else if (event.error === 'no-speech') {
      showToast('🎤 No speech detected. Please try again.', 3000);
    } else {
      showToast('🎤 Voice error: ' + event.error, 3000);
    }
  };

  recognition.onend = () => {
    stopVoice();
    // Auto-send if document is loaded and there's a question
    const input = document.getElementById('questionInput');
    if (input && input.value.trim() && documentText && !isLoading) {
      setTimeout(() => askQuestion(), 300);
    }
  };

  recognition.start();
}

function stopVoice() {
  isListening = false;
  if (recognition) { try { recognition.stop(); } catch(e) {} recognition = null; }
  const micBtn = document.getElementById('micBtn');
  const micStatus = document.getElementById('micStatus');
  if (micBtn) { micBtn.classList.remove('listening'); micBtn.title = 'Click to speak your question'; micBtn.textContent = '🎤'; }
  if (micStatus) micStatus.classList.add('hidden');
}

// ===== HELPERS =====
function handleKeyDown(e) { if (e.key==='Enter' && !e.shiftKey) { e.preventDefault(); askQuestion(); } }
function setSampleQ(btn) { document.getElementById('questionInput').value=btn.textContent; document.getElementById('questionInput').focus(); updateCharCount(); }
function updateCharCount() { const v=document.getElementById('questionInput').value; const el=document.getElementById('charCount'); if(el) el.textContent=v.length>0?`${v.length} chars`:''; }
function updateSendButton() { document.getElementById('sendBtn').disabled = !documentText || isLoading; }
function copyMsg(btn, text) { navigator.clipboard.writeText(text).then(()=>{ btn.textContent='✅ Copied!'; setTimeout(()=>btn.textContent='📋 Copy',2000); }); }

function getFriendlyError(msg) {
  if (msg==='RATE_LIMIT'||msg.includes('rate_limit')||msg.includes('429'))
    return '⏳ **Rate limit hit.** Groq is busy — please wait 30 seconds and try again.';
  if (msg.includes('401')||msg.includes('invalid_api_key')||msg.includes('auth'))
    return '🔑 **API key invalid.** Please check your Groq API key in app.js.';
  if (msg.includes('token')||msg.includes('context_length')||msg.includes('too long'))
    return '📄 **Question too complex for this document size.** Try asking about a specific section instead of the whole document.';
  if (msg.includes('network')||msg.includes('fetch')||msg.includes('Failed to fetch'))
    return '🌐 **Connection problem.** Check your internet connection and try again.';
  if (msg.includes('model')||msg.includes('decommissioned')||msg.includes('not found'))
    return '🤖 **Model unavailable.** The AI model may have changed — check app.js for the model name.';
  return `⚠️ **API Error:** ${msg}\n\nPlease try again or check the browser console (F12) for details.`;
}
