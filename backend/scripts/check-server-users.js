const axios = require('axios');

async function main() {
  try {
    const login = await axios.post('http://localhost:3099/api/auth/login', {
      username: 'dashboard.mediamonetix',
      password: 'Mdmtx@3563ye',
    });
    const token = login.data.token || login.data.accessToken;
    const users = await axios.get('http://localhost:3099/api/users', { headers: { Authorization: `Bearer ${token}` } });
    console.log('server users count', users.data.length);
    console.log(users.data.map((u) => ({ username: u.username, id: u.id, role: u.role }))); // show list
  } catch (err) {
    console.error('err', err.response ? err.response.status : err.code, err.response ? err.response.data : err.message);
    process.exit(1);
  }
}

main();
