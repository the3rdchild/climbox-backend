#!/bin/bash

# Start main backend in a new terminal
gnome-terminal -- bash -c "cd /home/user/climbox-backend && node index.js; exec bash"

# Start WhatsApp backend in another terminal
gnome-terminal -- bash -c "cd /home/user/climbox-backend/whatsapp && node whatsapp.js; exec bash"
