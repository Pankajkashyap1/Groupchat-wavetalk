// WaveTalk Frontend Client Application
// Manages real-time WebSockets, state, Group & Encrypted Personal Chats,
// message & joining timestamps, unread counts, and UI rendering.

(function () {
  'use strict';

  // --- STATE ---
  const state = {
    me: null, // { username, joinedAt, avatarColor }
    activeChat: { type: 'group', target: 'group' }, // or { type: 'personal', target: 'bob' }
    groupMessages: [],
    personalMessages: {}, // partnerUsername (lowercase) -> Array of messages
    roster: [], // Array of { username, joinedAt, lastSeen, avatarColor, isOnline }
    unread: {
      group: 0,
      personal: {} // partnerUsername -> count
    },
    typingUsers: {
      group: new Set(),
      personal: {} // partnerUsername -> boolean
    },
    ws: null,
    reconnectTimer: null,
    typingTimeout: null,
    isTyping: false,
    searchFilter: '',
    inChatSearch: ''
  };

  // --- DOM ELEMENTS ---
  const el = {
    // Auth Modal
    authModal: document.getElementById('auth-modal'),
    authForm: document.getElementById('auth-form'),
    usernameInput: document.getElementById('username-input'),
    pinInput: document.getElementById('pin-input'),
    authAvatarPreview: document.getElementById('auth-avatar-preview'),
    authError: document.getElementById('auth-error'),
    joinBtn: document.getElementById('join-btn'),

    // App Shell
    chatContainer: document.getElementById('chat-container'),
    sidebar: document.getElementById('sidebar'),
    sidebarBackdrop: document.getElementById('sidebar-backdrop'),
    mobileMenuBtn: document.getElementById('mobile-menu-btn'),
    logoutBtn: document.getElementById('logout-btn'),

    // User Profile
    myAvatar: document.getElementById('my-avatar'),
    myUsername: document.getElementById('my-username'),
    myJoinedTime: document.getElementById('my-joined-time'),

    // Search & Navigation
    userSearch: document.getElementById('user-search'),
    clearSearchBtn: document.getElementById('clear-search-btn'),
    channelGroup: document.getElementById('channel-group'),
    groupUnreadBadge: document.getElementById('group-unread-badge'),
    dmList: document.getElementById('dm-list'),

    // Footer & Status
    connDot: document.getElementById('conn-dot'),
    connText: document.getElementById('conn-text'),
    serverStats: document.getElementById('server-stats'),

    // Chat Main
    chatHeaderAvatar: document.getElementById('chat-header-avatar'),
    activeChatTitle: document.getElementById('active-chat-title'),
    activeChatSubtitle: document.getElementById('active-chat-subtitle'),
    e2eeBadge: document.getElementById('e2ee-badge'),
    securityInfoBtn: document.getElementById('security-info-btn'),
    searchMsgBtn: document.getElementById('search-msg-btn'),
    inChatSearchBar: document.getElementById('in-chat-search-bar'),
    msgSearchInput: document.getElementById('msg-search-input'),
    closeMsgSearch: document.getElementById('close-msg-search'),
    messageContainer: document.getElementById('message-container'),
    typingIndicator: document.getElementById('typing-indicator'),
    typingText: document.getElementById('typing-text'),

    // Composer
    messageInput: document.getElementById('message-input'),
    sendBtn: document.getElementById('send-btn'),
    emojiToggleBtn: document.getElementById('emoji-toggle-btn'),
    emojiPicker: document.getElementById('emoji-picker'),
    closeEmojiBtn: document.getElementById('close-emoji-btn'),

    // Security Modal
    securityModal: document.getElementById('security-modal'),
    securityPartnerName: document.getElementById('security-partner-name'),
    securityFingerprintCode: document.getElementById('security-fingerprint-code'),
    closeSecurityModal: document.getElementById('close-security-modal'),
    securityDoneBtn: document.getElementById('security-done-btn')
  };

  // --- AUDIO SYNTHESIZER FOR NOTIFICATIONS ---
  function playNotificationSound(type = 'msg') {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);

      if (type === 'msg') {
        osc.frequency.setValueAtTime(587.33, ctx.currentTime); // D5
        osc.frequency.exponentialRampToValueAtTime(880, ctx.currentTime + 0.12); // A5
        gain.gain.setValueAtTime(0.08, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.25);
        osc.start();
        osc.stop(ctx.currentTime + 0.25);
      }
    } catch {
      // Audio context might be restricted before user gesture
    }
  }

  // --- TIME FORMATTING HELPERS ---
  function formatClock(timestamp) {
    if (!timestamp) return '';
    const d = new Date(timestamp);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function formatFullDate(timestamp) {
    if (!timestamp) return '';
    const d = new Date(timestamp);
    return d.toLocaleDateString([], {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  }

  function formatRelativeJoin(timestamp) {
    if (!timestamp) return 'Joined recently';
    const d = new Date(timestamp);
    const now = new Date();
    const isToday = d.toDateString() === now.toDateString();
    if (isToday) {
      return `Joined today at ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    }
    return `Joined ${d.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })} at ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  }

  function getDateHeader(timestamp) {
    const d = new Date(timestamp);
    const today = new Date();
    const yesterday = new Date();
    yesterday.setDate(today.getDate() - 1);

    if (d.toDateString() === today.toDateString()) return 'Today';
    if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
    return d.toLocaleDateString([], { month: 'long', day: 'numeric', year: 'numeric' });
  }

  function getInitials(name) {
    if (!name) return '?';
    const clean = name.replace(/[^a-zA-Z0-9]/g, '');
    return (clean.slice(0, 2) || name.slice(0, 2)).toUpperCase();
  }

  function applyAvatarStyle(element, name, customColor = null) {
    if (!element) return;
    element.textContent = getInitials(name);
    if (customColor) {
      element.style.backgroundColor = customColor.bg;
      element.style.color = customColor.fg;
    } else {
      // Deterministic color
      const colors = [
        '#2563eb', '#059669', '#7c3aed', '#d97706', '#db2777', '#0891b2', '#ea580c', '#0d9488'
      ];
      let hash = 0;
      for (let i = 0; i < (name || '').length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0;
      element.style.backgroundColor = colors[Math.abs(hash) % colors.length];
      element.style.color = '#ffffff';
    }
  }

  // --- AVATAR PREVIEW ON TYPING ---
  el.usernameInput.addEventListener('input', () => {
    const val = el.usernameInput.value.trim();
    applyAvatarStyle(el.authAvatarPreview, val || '?');
  });

  // --- WEBSOCKET COMMUNICATION ---
  function connectWebSocket(username, pin = '') {
    if (state.ws) {
      state.ws.close();
      state.ws = null;
    }

    setConnectionStatus('connecting', 'Connecting...');

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}`;

    const ws = new WebSocket(wsUrl);
    state.ws = ws;

    ws.onopen = () => {
      console.log('[WS] Connected to chat gateway.');
      setConnectionStatus('online', 'Authenticating...');
      // Send join / login payload
      sendWS('auth_join', { username, pin });
    };

    ws.onmessage = async (event) => {
      let data;
      try {
        data = JSON.parse(event.data);
      } catch {
        return;
      }
      await handleServerMessage(data);
    };

    ws.onclose = () => {
      setConnectionStatus('offline', 'Disconnected');
      scheduleReconnect(username, pin);
    };

    ws.onerror = (err) => {
      console.error('[WS] Socket error:', err);
    };
  }

  function sendWS(type, payload = {}) {
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
      state.ws.send(JSON.stringify({ type, payload }));
    }
  }

  function scheduleReconnect(username, pin) {
    if (!state.me) return; // Don't auto-reconnect if logged out
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = setTimeout(() => {
      if (state.me) {
        console.log('[WS] Attempting reconnection...');
        connectWebSocket(username, pin);
      }
    }, 3000);
  }

  function setConnectionStatus(status, text) {
    el.connDot.className = `status-dot ${status === 'online' ? 'online' : 'offline'}`;
    el.connText.textContent = text;
  }

  // --- MESSAGE HANDLER ---
  async function handleServerMessage(data) {
    const { type } = data;

    switch (type) {
      case 'auth_success':
        onAuthSuccess(data);
        break;

      case 'auth_error':
        showAuthError(data.reason);
        break;

      case 'auth_required':
        showAuthModal();
        break;

      case 'group_message':
        onReceiveGroupMessage(data.message);
        break;

      case 'personal_message':
        await onReceivePersonalMessage(data.message, false);
        break;

      case 'personal_message_sent':
        await onReceivePersonalMessage(data.message, true);
        break;

      case 'personal_history':
        await onReceivePersonalHistory(data.partner, data.history);
        break;

      case 'system_event':
        onSystemEvent(data);
        break;

      case 'roster_update':
        onRosterUpdate(data.roster, data.onlineCount);
        break;

      case 'typing_update':
        onTypingUpdate(data);
        break;
    }
  }

  // --- AUTH LOGIC ---
  function onAuthSuccess(data) {
    state.me = data.user;

    // Save session in localStorage
    localStorage.setItem('wavetalk_session', JSON.stringify({
      username: data.user.username,
      pin: el.pinInput.value
    }));

    // Update UI profile
    el.myUsername.textContent = data.user.username;
    el.myJoinedTime.textContent = formatRelativeJoin(data.user.joinedAt);
    applyAvatarStyle(el.myAvatar, data.user.username, data.user.avatarColor);

    // Hydrate Group History
    state.groupMessages = data.groupHistory || [];

    // Hydrate Roster
    if (data.roster) {
      onRosterUpdate(data.roster);
    }

    // Hide Modal & Show Chat
    el.authModal.classList.add('hidden');
    el.chatContainer.classList.remove('hidden');
    setConnectionStatus('online', 'Connected');

    // Render Initial View
    renderSidebar();
    renderActiveChat();
  }

  function showAuthError(reason) {
    let msg = 'Authentication failed. Please check your credentials.';
    if (reason === 'PIN_REQUIRED') {
      msg = 'This username is PIN-protected. Please enter your passcode.';
    } else if (reason === 'INVALID_PIN') {
      msg = 'Incorrect passcode for this username.';
    } else if (typeof reason === 'string') {
      msg = reason;
    }
    el.authError.textContent = msg;
    el.authError.classList.remove('hidden');
    el.joinBtn.disabled = false;
    el.joinBtn.querySelector('.btn-text').textContent = 'Enter Chat';
  }

  function showAuthModal() {
    el.authModal.classList.remove('hidden');
    el.chatContainer.classList.add('hidden');
    el.authError.classList.add('hidden');
    el.joinBtn.disabled = false;
    el.joinBtn.querySelector('.btn-text').textContent = 'Enter Chat';
  }

  function logout() {
    state.me = null;
    localStorage.removeItem('wavetalk_session');
    if (state.ws) state.ws.close();
    showAuthModal();
  }

  // --- GROUP & PERSONAL MESSAGING ---
  function onReceiveGroupMessage(msg) {
    state.groupMessages.push(msg);

    if (state.activeChat.type === 'group') {
      appendMessageToView(msg, false);
      scrollToBottom();
    } else {
      state.unread.group++;
      updateUnreadBadges();
      playNotificationSound('msg');
    }
  }

  async function onReceivePersonalMessage(msg, isSenderSelf) {
    const partner = (msg.sender.toLowerCase() === state.me.username.toLowerCase()
      ? msg.recipient
      : msg.sender).toLowerCase();

    if (!state.personalMessages[partner]) {
      state.personalMessages[partner] = [];
    }

    // Decrypt the message payload on the client
    const decrypted = await window.chatCrypto.decrypt(
      msg.ciphertext,
      msg.iv,
      state.me.username,
      partner
    );
    msg.decryptedText = decrypted;

    state.personalMessages[partner].push(msg);

    if (state.activeChat.type === 'personal' && state.activeChat.target.toLowerCase() === partner) {
      appendMessageToView(msg, true);
      scrollToBottom();
      // Send read receipt
      sendWS('mark_read', { sender: msg.sender });
    } else if (!isSenderSelf) {
      state.unread.personal[partner] = (state.unread.personal[partner] || 0) + 1;
      updateUnreadBadges();
      playNotificationSound('msg');
    }

    renderSidebar();
  }

  async function onReceivePersonalHistory(partner, history) {
    const partnerKey = partner.toLowerCase();
    const decryptedHistory = [];

    for (const msg of history) {
      const decrypted = await window.chatCrypto.decrypt(
        msg.ciphertext,
        msg.iv,
        state.me.username,
        partner
      );
      msg.decryptedText = decrypted;
      decryptedHistory.push(msg);
    }

    state.personalMessages[partnerKey] = decryptedHistory;

    if (state.activeChat.type === 'personal' && state.activeChat.target.toLowerCase() === partnerKey) {
      renderMessagesList(decryptedHistory, true);
      scrollToBottom();
    }
  }

  function onSystemEvent(data) {
    const systemMsg = {
      id: `sys_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      type: 'system',
      text: data.text,
      timestamp: data.timestamp || Date.now(),
      detail: data.joinedAt ? `Joined: ${formatClock(data.joinedAt)}` : ''
    };

    state.groupMessages.push(systemMsg);

    if (state.activeChat.type === 'group') {
      appendMessageToView(systemMsg, false);
      scrollToBottom();
    }
  }

  function onRosterUpdate(roster, onlineCount) {
    state.roster = roster || [];
    const online = onlineCount !== undefined ? onlineCount : state.roster.filter(u => u.isOnline).length;
    el.serverStats.textContent = `${online} online`;

    renderSidebar();
    updateActiveChatHeader();
  }

  function onTypingUpdate(data) {
    if (data.target === 'group') {
      if (data.isTyping) {
        state.typingUsers.group.add(data.username);
      } else {
        state.typingUsers.group.delete(data.username);
      }
    } else if (data.target === 'personal') {
      state.typingUsers.personal[data.sender.toLowerCase()] = data.isTyping;
    }
    updateTypingUI();
  }

  // --- SENDING MESSAGES ---
  async function sendMessage() {
    const rawText = el.messageInput.value.trim();
    if (!rawText || !state.me) return;

    el.messageInput.value = '';
    el.messageInput.style.height = 'auto';
    signalTyping(false);

    if (state.activeChat.type === 'group') {
      sendWS('chat_group', { text: rawText });
    } else if (state.activeChat.type === 'personal') {
      const recipient = state.activeChat.target;
      try {
        const encrypted = await window.chatCrypto.encrypt(
          rawText,
          state.me.username,
          recipient
        );

        sendWS('chat_personal', {
          recipient,
          ciphertext: encrypted.ciphertext,
          iv: encrypted.iv
        });
      } catch (err) {
        console.error('[Send PM Error]', err);
      }
    }
  }

  // Typing debounce
  function handleTypingInput() {
    if (!state.isTyping) {
      state.isTyping = true;
      signalTyping(true);
    }
    clearTimeout(state.typingTimeout);
    state.typingTimeout = setTimeout(() => {
      state.isTyping = false;
      signalTyping(false);
    }, 2000);
  }

  function signalTyping(isTyping) {
    if (!state.me) return;
    if (state.activeChat.type === 'group') {
      sendWS('typing', { target: 'group', isTyping });
    } else if (state.activeChat.type === 'personal') {
      sendWS('typing', { target: state.activeChat.target, isTyping });
    }
  }

  // --- SWITCHING CHATS ---
  function switchChat(type, target) {
    state.activeChat = { type, target };
    state.inChatSearch = '';
    el.msgSearchInput.value = '';
    el.inChatSearchBar.classList.add('hidden');

    // Clear unread
    if (type === 'group') {
      state.unread.group = 0;
    } else if (type === 'personal') {
      state.unread.personal[target.toLowerCase()] = 0;
      sendWS('mark_read', { sender: target });
      // Fetch latest history from DB if not loaded
      sendWS('get_personal_history', { partner: target });
    }

    updateUnreadBadges();
    renderSidebar();
    renderActiveChat();

    // Close mobile drawer if open
    closeMobileSidebar();
  }

  // --- RENDERING VIEWS ---
  function renderSidebar() {
    if (!state.me) return;

    // Filter DM users by search
    const query = state.searchFilter.toLowerCase().trim();
    const otherUsers = state.roster.filter(u => u.username.toLowerCase() !== state.me.username.toLowerCase());
    const filteredUsers = query
      ? otherUsers.filter(u => u.username.toLowerCase().includes(query))
      : otherUsers;

    // Active Highlight on Group
    el.channelGroup.className = `nav-item ${state.activeChat.type === 'group' ? 'active' : ''}`;

    // Render DMs
    if (filteredUsers.length === 0) {
      el.dmList.innerHTML = `<div class="empty-list-notice">${query ? 'No matching members' : 'No other members yet'}</div>`;
      return;
    }

    el.dmList.innerHTML = '';
    filteredUsers.forEach(u => {
      const uKey = u.username.toLowerCase();
      const isActive = state.activeChat.type === 'personal' && state.activeChat.target.toLowerCase() === uKey;
      const unreadCount = state.unread.personal[uKey] || 0;

      const item = document.createElement('div');
      item.className = `dm-item ${isActive ? 'active' : ''}`;
      item.dataset.username = u.username;

      const joinTimeFormatted = formatRelativeJoin(u.joinedAt);

      item.innerHTML = `
        <div class="dm-avatar-wrapper">
          <div class="avatar-circle">${getInitials(u.username)}</div>
          <span class="status-dot ${u.isOnline ? 'online' : 'offline'}" title="${u.isOnline ? 'Online' : 'Offline'}"></span>
        </div>
        <div class="dm-info">
          <div class="dm-top-row">
            <span class="dm-name">@${escapeHtml(u.username)}</span>
            ${unreadCount > 0 ? `<span class="unread-pill">${unreadCount}</span>` : ''}
          </div>
          <div class="dm-join-meta" title="${joinTimeFormatted}">
            ${u.isOnline ? 'Active now' : joinTimeFormatted}
          </div>
        </div>
      `;

      applyAvatarStyle(item.querySelector('.avatar-circle'), u.username, u.avatarColor);

      item.addEventListener('click', () => switchChat('personal', u.username));
      el.dmList.appendChild(item);
    });
  }

  function updateActiveChatHeader() {
    if (state.activeChat.type === 'group') {
      el.activeChatTitle.textContent = 'iitbhilai';
      applyAvatarStyle(el.chatHeaderAvatar, 'iitbhilai', { bg: '#2563eb', fg: '#fff' });
      el.chatHeaderAvatar.textContent = '#';

      const onlineCount = state.roster.filter(u => u.isOnline).length;
      el.activeChatSubtitle.textContent = `Public Room • ${onlineCount} members online • Stored in Database`;
      el.e2eeBadge.classList.add('hidden');
      el.securityInfoBtn.classList.add('hidden');
      el.messageInput.placeholder = 'Message #iitbhilai... (Enter to send, Shift+Enter for newline)';
    } else {
      const partner = state.activeChat.target;
      const partnerUser = state.roster.find(u => u.username.toLowerCase() === partner.toLowerCase());
      
      el.activeChatTitle.textContent = `@${partner}`;
      applyAvatarStyle(el.chatHeaderAvatar, partner, partnerUser?.avatarColor);

      const joinText = partnerUser ? formatRelativeJoin(partnerUser.joinedAt) : 'Member';
      const statusText = partnerUser?.isOnline ? 'Online now' : 'Offline';
      el.activeChatSubtitle.textContent = `${statusText} • ${joinText}`;

      el.e2eeBadge.classList.remove('hidden');
      el.securityInfoBtn.classList.remove('hidden');
      el.messageInput.placeholder = `Encrypted message to @${partner}...`;
    }
  }

  function renderActiveChat() {
    updateActiveChatHeader();

    if (state.activeChat.type === 'group') {
      renderMessagesList(state.groupMessages, false);
    } else {
      const partnerKey = state.activeChat.target.toLowerCase();
      const messages = state.personalMessages[partnerKey] || [];
      renderMessagesList(messages, true);
    }
    scrollToBottom();
    updateTypingUI();
  }

  function renderMessagesList(messages, isPersonal) {
    el.messageContainer.innerHTML = '';

    const filterQuery = state.inChatSearch.toLowerCase().trim();
    const displayList = filterQuery
      ? messages.filter(m => (m.text || m.decryptedText || '').toLowerCase().includes(filterQuery))
      : messages;

    if (displayList.length === 0) {
      const msg = filterQuery
        ? 'No matching messages found.'
        : (isPersonal ? '🔒 Direct chat is end-to-end encrypted. Say hello!' : 'No messages yet — start the conversation!');
      el.messageContainer.innerHTML = `<div class="chat-loading-notice">${msg}</div>`;
      return;
    }

    let lastDate = '';

    displayList.forEach(m => {
      const dateHeader = getDateHeader(m.timestamp);
      if (dateHeader !== lastDate) {
        lastDate = dateHeader;
        const divider = document.createElement('div');
        divider.className = 'date-divider';
        divider.innerHTML = `<span class="date-divider-text">${dateHeader}</span>`;
        el.messageContainer.appendChild(divider);
      }

      appendMessageToView(m, isPersonal);
    });
  }

  function appendMessageToView(m, isPersonal) {
    if (m.type === 'system') {
      const row = document.createElement('div');
      row.className = 'system-event-row';
      row.innerHTML = `
        <div class="system-event-pill">
          <span>⚡</span>
          <span>${escapeHtml(m.text)}</span>
          <span class="system-event-time" title="${formatFullDate(m.timestamp)}">${formatClock(m.timestamp)}</span>
        </div>
      `;
      el.messageContainer.appendChild(row);
      return;
    }

    const isMine = state.me && m.sender.toLowerCase() === state.me.username.toLowerCase();
    const textContent = isPersonal ? (m.decryptedText || '[Encrypted Message]') : (m.text || '');

    const row = document.createElement('div');
    row.className = `message-row ${isMine ? 'mine' : ''}`;

    const senderUser = state.roster.find(u => u.username.toLowerCase() === m.sender.toLowerCase());
    const senderColor = senderUser ? senderUser.avatarColor : null;

    row.innerHTML = `
      <div class="message-avatar-col">
        <div class="avatar-circle">${getInitials(m.sender)}</div>
      </div>
      <div class="message-body-col">
        <div class="message-meta-row">
          <span class="message-sender">${isMine ? 'You' : escapeHtml(m.sender)}</span>
          <span class="message-time" title="${formatFullDate(m.timestamp)}">${formatClock(m.timestamp)}</span>
          ${isPersonal ? `<span class="encrypted-msg-badge" title="End-to-End Encrypted">🔒</span>` : ''}
        </div>
        <div class="message-bubble">${escapeHtml(textContent)}</div>
      </div>
    `;

    applyAvatarStyle(row.querySelector('.avatar-circle'), m.sender, senderColor);
    el.messageContainer.appendChild(row);
  }

  function updateUnreadBadges() {
    if (state.unread.group > 0) {
      el.groupUnreadBadge.textContent = state.unread.group;
      el.groupUnreadBadge.classList.remove('hidden');
    } else {
      el.groupUnreadBadge.classList.add('hidden');
    }
  }

  function updateTypingUI() {
    let text = '';
    if (state.activeChat.type === 'group') {
      const list = [...state.typingUsers.group].filter(u => state.me && u !== state.me.username);
      if (list.length === 1) text = `${list[0]} is typing...`;
      else if (list.length > 1) text = `${list.slice(0, 2).join(', ')} are typing...`;
    } else {
      const partnerKey = state.activeChat.target.toLowerCase();
      if (state.typingUsers.personal[partnerKey]) {
        text = `@${state.activeChat.target} is typing...`;
      }
    }

    if (text) {
      el.typingText.textContent = text;
      el.typingIndicator.classList.remove('hidden');
    } else {
      el.typingIndicator.classList.add('hidden');
    }
  }

  function scrollToBottom() {
    setTimeout(() => {
      el.messageContainer.scrollTop = el.messageContainer.scrollHeight;
    }, 10);
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  // --- MOBILE SIDEBAR HANDLERS ---
  function openMobileSidebar() {
    el.sidebar.classList.add('open');
    el.sidebarBackdrop.classList.add('open');
  }

  function closeMobileSidebar() {
    el.sidebar.classList.remove('open');
    el.sidebarBackdrop.classList.remove('open');
  }

  // --- EVENT LISTENERS ---

  // Auth Submit
  el.authForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const username = el.usernameInput.value.trim();
    const pin = el.pinInput.value.trim();

    if (username.length < 2) {
      showAuthError('Username must be at least 2 characters.');
      return;
    }

    el.joinBtn.disabled = true;
    el.joinBtn.querySelector('.btn-text').textContent = 'Connecting...';
    connectWebSocket(username, pin);
  });

  // Logout
  el.logoutBtn.addEventListener('click', logout);

  // Group Channel Click
  el.channelGroup.addEventListener('click', () => switchChat('group', 'group'));

  // Search in Sidebar
  el.userSearch.addEventListener('input', (e) => {
    state.searchFilter = e.target.value;
    if (state.searchFilter) {
      el.clearSearchBtn.classList.remove('hidden');
    } else {
      el.clearSearchBtn.classList.add('hidden');
    }
    renderSidebar();
  });

  el.clearSearchBtn.addEventListener('click', () => {
    el.userSearch.value = '';
    state.searchFilter = '';
    el.clearSearchBtn.classList.add('hidden');
    renderSidebar();
  });

  // In-Chat Search
  el.searchMsgBtn.addEventListener('click', () => {
    el.inChatSearchBar.classList.toggle('hidden');
    if (!el.inChatSearchBar.classList.contains('hidden')) {
      el.msgSearchInput.focus();
    }
  });

  el.closeMsgSearch.addEventListener('click', () => {
    el.inChatSearchBar.classList.add('hidden');
    state.inChatSearch = '';
    el.msgSearchInput.value = '';
    renderActiveChat();
  });

  el.msgSearchInput.addEventListener('input', (e) => {
    state.inChatSearch = e.target.value;
    renderActiveChat();
  });

  // Composer Input & Send
  el.sendBtn.addEventListener('click', sendMessage);

  el.messageInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  el.messageInput.addEventListener('input', () => {
    handleTypingInput();
    // Auto grow textarea
    el.messageInput.style.height = 'auto';
    el.messageInput.style.height = `${Math.min(el.messageInput.scrollHeight, 120)}px`;
  });

  // Emoji Picker
  el.emojiToggleBtn.addEventListener('click', () => {
    el.emojiPicker.classList.toggle('hidden');
  });

  el.closeEmojiBtn.addEventListener('click', () => {
    el.emojiPicker.classList.add('hidden');
  });

  document.querySelectorAll('.emoji-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const emoji = btn.dataset.emoji;
      el.messageInput.value += emoji;
      el.messageInput.focus();
      el.emojiPicker.classList.add('hidden');
    });
  });

  // Security / Fingerprint Modal
  el.securityInfoBtn.addEventListener('click', async () => {
    if (state.activeChat.type !== 'personal') return;
    const partner = state.activeChat.target;
    el.securityPartnerName.textContent = `@${partner}`;
    const code = await window.chatCrypto.getFingerprint(state.me.username, partner);
    el.securityFingerprintCode.textContent = code;
    el.securityModal.classList.remove('hidden');
  });

  el.closeSecurityModal.addEventListener('click', () => el.securityModal.classList.add('hidden'));
  el.securityDoneBtn.addEventListener('click', () => el.securityModal.classList.add('hidden'));

  // Mobile Navigation Drawer
  el.mobileMenuBtn.addEventListener('click', openMobileSidebar);
  el.sidebarBackdrop.addEventListener('click', closeMobileSidebar);

  // Close emoji picker when clicking outside
  document.addEventListener('click', (e) => {
    if (!el.emojiPicker.contains(e.target) && e.target !== el.emojiToggleBtn) {
      el.emojiPicker.classList.add('hidden');
    }
  });

  // --- AUTO-LOGIN FROM LOCALSTORAGE ---
  function initAutoLogin() {
    try {
      const saved = localStorage.getItem('wavetalk_session');
      if (saved) {
        const { username, pin } = JSON.parse(saved);
        if (username) {
          el.usernameInput.value = username;
          el.pinInput.value = pin || '';
          applyAvatarStyle(el.authAvatarPreview, username);
          connectWebSocket(username, pin || '');
          return;
        }
      }
    } catch (e) {
      console.warn('[Auto-login] Could not parse saved session');
    }
  }

  // Start app
  initAutoLogin();

})();
