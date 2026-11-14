function request(path, data) {
  const options = data === undefined ? {} : {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  };
  return fetch('/api/' + path, options).then(async response => {
    if (!response.headers.get('Content-Type')?.includes('application/json')) {
      throw new Error('Сетевые комнаты доступны на сервере игры.');
    }
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? 'Не удалось выполнить запрос.');
    return result;
  });
}

export function createOnlineClient({ dialog, node, nameValue, start, update, failure, playSound }) {
  let socket;
  let account;
  let currentRoom;
  let playing = false;
  let roomStatus;
  let roomButtons;
  let lastView = 1;
  let intentional = false;

  function button(label, callback) {
    const result = node('button', 'small-button', label);
    result.type = 'button';
    result.addEventListener('click', callback);
    return result;
  }

  function field(parent, label, options) {
    const wrapper = node('label', 'form-label', label);
    const input = node('input', 'form-input');
    Object.assign(input, options);
    wrapper.append(input);
    parent.append(wrapper);
    return input;
  }

  function send(data) {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(data));
  }

  function connect() {
    if (socket?.readyState === WebSocket.OPEN) return Promise.resolve();
    return new Promise((resolve, reject) => {
      intentional = false;
      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      socket = new WebSocket(protocol + '//' + location.host + '/socket');
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', () => reject(new Error('Не удалось подключиться к серверу игры.')), { once: true });
      socket.addEventListener('close', () => {
        if (!intentional) {
          const message = 'Связь с сервером потеряна. Войдите в комнату по тому же коду, чтобы продолжить матч.';
          if (roomStatus?.isConnected) roomStatus.textContent = message;
          if (playing) failure(message);
        }
        playing = false;
        socket = undefined;
      });
      socket.addEventListener('message', event => {
        const data = JSON.parse(event.data);
        if (data.type === 'error') {
          if (roomStatus?.isConnected) roomStatus.textContent = data.error;
          else failure(data.error);
          return;
        }
        if (data.type === 'room') {
          currentRoom = data;
          renderRoom();
        }
        if (data.type === 'sound' && data.cue === 'mouseclick1') playSound(data.cue);
        if (data.type === 'frame') {
          if (!playing) {
            playing = true;
            lastView = data.frame.seat;
            start(data.frame);
          } else update(data.frame);
        }
      });
    });
  }

  function renderRoom() {
    if (!currentRoom || !roomStatus?.isConnected) return;
    roomStatus.textContent = 'Комната ' + currentRoom.code + ' · ' + currentRoom.players.map(player => player.name).join(', ');
    roomButtons.replaceChildren(button('Покинуть комнату', () => {
      send({ type: 'leave' });
      currentRoom = undefined;
      showRoomMenu();
    }));
    if (currentRoom.host) {
      const start = button('Начать матч', () => send({ type: 'start' }));
      start.disabled = currentRoom.players.length < 2;
      roomButtons.prepend(start);
    }
  }

  function showRoomMenu() {
    const content = dialog('Сетевая игра');
    content.append(node('p', 'dialog-copy', 'Вы вошли как ' + account.name + '. Для матча нужно от двух до восьми игроков.'));
    const code = field(content, 'Код комнаты', { maxLength: 6, value: currentRoom?.code ?? '', autocomplete: 'off' });
    roomStatus = node('p', 'dialog-copy', 'Создайте комнату и передайте код соперникам.');
    roomStatus.setAttribute('role', 'status');
    roomButtons = node('div', 'dialog-buttons');
    const submit = async message => {
      try {
        await connect();
        send(message);
      } catch (error) {
        roomStatus.textContent = error.message;
      }
    };
    roomButtons.append(
      button('Создать комнату', () => void submit({ type: 'create' })),
      button('Войти по коду', () => void submit({ type: 'join', code: code.value.trim().toUpperCase() })),
      button('Сетевой профиль', async () => {
        try {
          const result = await request('profile');
          const panel = dialog('Сетевой профиль');
          panel.append(node('p', 'dialog-copy', result.account.name));
          if (!result.matches.length) panel.append(node('p', 'dialog-copy', 'У вас пока нет завершённых сетевых матчей.'));
          for (const match of result.matches) {
            panel.append(node('p', 'dialog-copy', 'Место ' + match.place + ' · Волна ' + match.wave + ' · ' + match.kills + ' убийств'));
          }
          panel.append(button('К комнатам', showRoomMenu));
        } catch (error) {
          roomStatus.textContent = error.message;
        }
      }),
      button('Выйти из аккаунта', async () => {
        try {
          await request('logout', {});
          disconnect();
          account = undefined;
          showLogin();
        } catch (error) {
          roomStatus.textContent = error.message;
        }
      }),
    );
    content.append(roomButtons, roomStatus);
    if (currentRoom && socket?.readyState === WebSocket.OPEN) renderRoom();
  }

  function showLogin() {
    const content = dialog('Сетевой профиль');
    const form = node('form');
    const email = field(form, 'Электронная почта', { type: 'email', autocomplete: 'username', required: true, maxLength: 254 });
    const password = field(form, 'Пароль', { type: 'password', autocomplete: 'current-password', required: true, maxLength: 128 });
    const errorText = node('p', 'dialog-copy');
    errorText.setAttribute('role', 'status');
    const actions = node('div', 'dialog-buttons');
    async function submit(mode) {
      if (!form.reportValidity()) return;
      const buttons = [...actions.querySelectorAll('button')];
      for (const control of buttons) control.disabled = true;
      errorText.textContent = 'Подключение…';
      try {
        const result = await request(mode, { email: email.value.trim(), password: password.value, name: nameValue() });
        password.value = '';
        account = result.account;
        showRoomMenu();
      } catch (error) {
        errorText.textContent = error.message;
      } finally {
        for (const control of buttons) control.disabled = false;
      }
    }
    const login = node('button', 'small-button', 'Войти');
    login.type = 'submit';
    actions.append(login, button('Создать профиль', () => void submit('register')));
    form.addEventListener('submit', event => {
      event.preventDefault();
      void submit('login');
    });
    form.append(actions, errorText);
    content.append(form);
  }

  function disconnect() {
    intentional = true;
    send({ type: 'leave' });
    socket?.close();
    playing = false;
    currentRoom = undefined;
  }

  return {
    async show() {
      if (account) return showRoomMenu();
      const content = dialog('Сетевой профиль');
      content.append(node('p', 'dialog-copy', 'Подключение…'));
      try {
        const result = await request('session');
        account = result.account;
        if (account) showRoomMenu();
        else showLogin();
      } catch (error) {
        content.replaceChildren(node('p', 'dialog-copy', error.message));
      }
    },
    action(input) { send({ type: 'action', input }); },
    view(seat) {
      if (lastView !== seat) send({ type: 'view', seat });
      lastView = seat;
    },
    disconnect,
    get playing() { return playing; },
  };
}
