async function fetchGuildMembers() {
  const token = process.env.DISCORD_BOT_TOKEN;
  const guildId = process.env.DISCORD_GUILD_ID;
  if (!token || !guildId) {
    const err = new Error('DISCORD_BOT_TOKEN / DISCORD_GUILD_ID が未設定です');
    err.statusCode = 503;
    throw err;
  }

  const members = [];
  let after = '0';
  for (let i = 0; i < 20; i++) {
    const url = `https://discord.com/api/v10/guilds/${guildId}/members?limit=1000&after=${after}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bot ${token}` },
    });
    if (!res.ok) {
      const body = await res.text();
      const err = new Error(`Discord API ${res.status}: ${body.slice(0, 200)}`);
      err.statusCode = res.status;
      throw err;
    }
    const batch = await res.json();
    if (!Array.isArray(batch) || !batch.length) break;
    for (const row of batch) {
      const user = row.user;
      if (!user || user.bot) continue;
      const avatar = user.avatar
        ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=128`
        : `https://cdn.discordapp.com/embed/avatars/${Number(BigInt(user.id) >> 22n) % 6n}.png`;
      members.push({
        discordId: user.id,
        name: row.nick || user.global_name || user.username,
        username: user.username,
        avatarUrl: avatar,
      });
    }
    after = batch[batch.length - 1].user.id;
    if (batch.length < 1000) break;
  }

  members.sort((a, b) => a.name.localeCompare(b.name, 'ja'));
  return members;
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
    res.status(204).end();
    return;
  }
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  try {
    const members = await fetchGuildMembers();
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.status(200).json({ members });
  } catch (e) {
    res.status(e.statusCode || 500).json({ error: String(e.message || e) });
  }
}
