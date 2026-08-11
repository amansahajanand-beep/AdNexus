const axios = require('axios');

async function main() {
  const username = process.argv[2] || 'testdomainuser1';
  const password = process.argv[3] || 'Test@1234';
  try {
    const login = await axios.post('http://localhost:3099/api/auth/login', { username, password });
    console.log('login status', login.status);
    console.log('user', login.data.user);
    const token = login.data.token || login.data.accessToken;
    if (!token) {
      console.error('no token returned');
      process.exit(1);
    }
    const me = await axios.get('http://localhost:3099/api/auth/me', { headers: { Authorization: `Bearer ${token}` } });
    console.log('me status', me.status);
    console.log('me data', me.data);
  } catch (err) {
    console.error('err', err.response ? err.response.status : err.code, err.response ? err.response.data : err.message);
    process.exit(1);
  }
}

main();
