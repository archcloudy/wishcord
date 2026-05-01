# Wishcord
Welcome to my most stupiest project ever where i make something stupid out of boredom!!! :D

Wishcord is a Discord compatible server written in JavaScript.
It is designed to be a self hosted alternative to the Discord backend while maintaining compatibility with Discord clients.

## Setup Guide
### Prerequisites:
- A running PostgreSQL server.
- Node.JS and npm

### Installation
1. **Setup the database**: Create new database via CLI or pgAdmin and import ./init.sql located on project directory
2. **Install Dependencies**: Run `npm install` on project directory 
3. **Configuring the server**: Copy `example.env` to `.env`. Edit the config to match your needs.
4. **Start the server**: Run the command `npm run start`
(For **testing to made changes**, run `npm run dev`)

## Acknowledgements (and Credit?)
- oldcordV3 & ziad87: Token generation logic, permissions and sessions
- Discord: Other SVGs, images, fonts, etc - for the base clients (before patches) & some parts of Selector/Admin panel. Discord Developer Portal also has documented API responses for this recreation. And also erlpack.
- Verycord (C++ Closed-Source): For some codes used as references for gateway + other stuff
