import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const { DISCORD_BOT_TOKEN, DISCORD_APP_ID } = process.env;

const commandData = {
    name: 'match',
    description: 'Fetch the latest Dota 2 match details for a player',
    options: [
        {
            name: 'account_id',
            description: 'The Steam/Dota 2 Account ID',
            type: 3, // String type to prevent large numbers getting corrupted
            required: true
        }
    ]
};

async function registerCommands() {
    try {
        await axios.put(
            `https://discord.com/api/v10/applications/${DISCORD_APP_ID}/commands`,
            [commandData],
            { headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}` } }
        );
        console.log('🚀 Successfully registered global slash commands!');
    } catch (error) {
        console.error('❌ Error registering commands:', error.response?.data || error.message);
    }
}

registerCommands();