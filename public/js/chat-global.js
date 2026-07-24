(function () {
  var box = document.getElementById('chat-box');
  var form = document.getElementById('message-form');
  var input = document.getElementById('message-input');
  var sendButton = document.getElementById('message-send');
  var messagesEl = document.getElementById('messages');
  var statusEl = document.getElementById('chat-status');
  if (!box || !form || !input || !sendButton || !messagesEl || typeof io !== 'function') return;

  var currentUserId = Number(box.dataset.currentUserId);
  var joined = false;
  var sending = false;

  var socket = io();

  function setStatus(text) {
    if (statusEl) statusEl.textContent = text || '';
  }

  function appendMessage(message) {
    var article = document.createElement('article');
    article.className = 'message' + (message.sender.id === currentUserId ? ' mine' : '');
    var meta = document.createElement('div');
    var link = document.createElement('a');
    link.href = '/users/' + encodeURIComponent(message.sender.id);
    var strong = document.createElement('strong');
    strong.textContent = message.sender.nickname;
    link.appendChild(strong);
    var time = document.createElement('time');
    time.textContent = new Date(message.createdAt).toLocaleString('ko-KR');
    meta.appendChild(link);
    meta.appendChild(time);
    var p = document.createElement('p');
    p.textContent = message.body;
    article.appendChild(meta);
    article.appendChild(p);
    messagesEl.appendChild(article);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  socket.on('connect', function () {
    socket.emit('globalChat:join', {}, function (res) {
      if (res && res.ok) {
        joined = true;
        setStatus('');
      } else {
        joined = false;
        setStatus('실시간 연결에 실패했습니다. 새로고침 후 다시 시도해 주세요.');
      }
    });
  });

  socket.on('disconnect', function () {
    joined = false;
    setStatus('연결이 끊어졌습니다. 재연결 중...');
  });

  socket.on('globalChat:message', function (message) {
    appendMessage(message);
  });

  function trySend() {
    var body = input.value;
    if (!body || !body.trim()) return;
    if (sending || !joined) return;
    sending = true;
    sendButton.disabled = true;
    socket.emit('globalChat:message', { body: body }, function (res) {
      sending = false;
      sendButton.disabled = false;
      if (res && res.ok) {
        input.value = '';
      } else if (res && res.error === 'RATE_LIMITED') {
        setStatus('메시지 전송 한도를 초과했습니다. 잠시 후 다시 시도해 주세요.');
      } else {
        setStatus('메시지를 보낼 수 없습니다. 잠시 후 다시 시도해 주세요.');
      }
    });
  }

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    trySend();
  });

  input.addEventListener('keydown', function (event) {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      trySend();
    }
  });

  if (messagesEl) messagesEl.scrollTop = messagesEl.scrollHeight;
}());
