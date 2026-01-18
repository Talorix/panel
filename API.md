# API Documentation (Updated)

## Authentication & Requirements

All endpoints require an API Key.

**Headers:**

* `Authorization`: `Bearer <YOUR_API_TOKEN>`
* *Alternatively*: `x-api-key`: `<YOUR_API_TOKEN>`

**Response Format:**
All responses are returned as JSON.

* Success: `{ "success": true, ...data }`
* Error: `{ "error": "Message" }`

---

## Nodes

**Required Permission:** `nodes`

### Create Node

`POST /api/v1/node/create`

**Send (JSON Body):**

```json
{
  "name": "Node Name",
  "ip": "192.168.1.1",
  "port": 3000,
  "ftpPort": 21 // Optional
}

```

**Get:**

```json
{
  "success": true,
  "id": "uuid-string",
  "key": "generated-connection-key",
  "status": "created"
}

```

### List Nodes

`GET /api/v1/nodes`

**Send:** None

**Get:**

```json
{
  "success": true,
  "nodes": [
    {
      "id": "...",
      "name": "...",
      "ip": "...",
      "status": "online",
      "allocations": []
    }
  ]
}

```

### Get Node Info

`POST /api/v1/node/:id`

**Send:** None (ID is in URL)

**Get:**

```json
{
  "success": true,
  "node": {
    "id": "...",
    "status": "..."
  }
}

```

### Get Configuration Command

`POST /api/v1/node/:id/configure-key`

**Send:** None

**Get:**

```json
{
  "command": "npm run configure -- --key ... --panel ... --port ... --ftpport ..."
}

```

### Get Node Version

`GET /api/v1/node/ver/:id`

**Send:** None

**Get:**

```json
{
  "success": true,
  "version": "1.0.0" 
}

```

### Get Node Stats

`GET /api/v1/node/stats/:id`

**Send:** None

**Get:**

```json
{
  "success": true,
  "stats": { ... } // or null
}

```

### Delete Node

`POST /api/v1/node/:id/delete`
*Requires Permissions: `nodes`, `servers*`

**Send:** None

**Get:**

```json
{
  "success": true,
  "deletedServers": 5 // Count of servers deleted associated with this node
}

```

---

## Allocations

**Required Permission:** `nodes`

### Add Allocation(s)

`POST /api/v1/node/:id/allocations/add`

**Send (JSON Body):**
*Note: `port` can be a single number or a range string (e.g., "25565-25570").*

```json
{
  "ip": "0.0.0.0",
  "port": "25565" // or number 25565
}

```

**Get (Single Port):**

```json
{
  "success": true,
  "allocation": {
    "id": "...",
    "ip": "0.0.0.0",
    "port": 25565
  }
}

```

**Get (Port Range):**

```json
{
  "success": true,
  "added": [ ... ],
  "totalAdded": 5
}

```

### Edit Allocation

`POST /api/v1/node/:id/allocations/edit/:allocationId`

**Send (JSON Body):**

```json
{
  "ip": "1.2.3.4",
  "domain": "example.com", // Optional
  "port": 25565
}

```

**Get:**

```json
{
  "success": true,
  "allocation": { ... }
}

```

### Delete Allocation

`DELETE /api/v1/node/:id/allocations/delete/:allocationId`

**Send:** None

**Get:**

```json
{
  "success": true
}

```

---

## Images

**Required Permission:** `images`

### List Images

`GET /api/v1/images`

**Send:** None

**Get:**

```json
{
  "success": true,
  "images": [ ... ]
}

```

### Create Image

`POST /api/v1/images/new`

**Send (JSON Body):**

```json
{
  "dockerImage": "repo/image:tag",
  "name": "Image Name",
  "description": "Optional description",
  "envs": { "VARIABLE": "default_value" },
  "files": [],
  "features": []
}

```

**Get:**

```json
{
  "success": true,
  "image": {
    "id": "...",
    "createdAt": 123456789,
    ...
  }
}

```

### Delete Image

`POST /api/v1/images/delete/:id`

**Send:** None

**Get:**

```json
{
  "success": true
}

```

---

## Servers

**Required Permission:** `servers`

### List Servers

`GET /api/v1/servers`

**Send:** None

**Get:**

```json
{
  "success": true,
  "servers": [ ... ]
}

```

### Create Server

`POST /api/v1/servers/new`

**Send (JSON Body):**

```json
{
  "imageId": "uuid",
  "nodeId": "uuid",
  "allocationId": "uuid",
  "name": "Server Name",
  "ram": "1024",
  "core": "1",
  "disk": "1024",
  "userId": "uuid",
  "env": { "SERVER_PORT": "25565" }
}

```

**Get:**

```json
{
  "success": true,
  "server": {
    "id": "short-uuid",
    "identifier": "...",
    "ftp": { ... },
    "containerId": "..."
  }
}

```

### Edit Server

`POST /api/v1/edit/:serverId`

**Send (JSON Body):**

```json
{
  "name": "New Name",
  "ram": "2048",
  "core": "2",
  "disk": "5000",
  "imageId": "new-image-uuid", // Optional
  "env": { ... },
  "files": [ ... ]
}

```

**Get:**

```json
{
  "success": true,
  "server": { ... }
}

```

### Suspend Server

`POST /api/v1/servers/suspend/:id`

**Send:** None

**Get:**

```json
{
  "success": true,
  "suspended": true
}

```

### Unsuspend Server

`POST /api/v1/servers/unsuspend/:id`

**Send:** None

**Get:**

```json
{
  "success": true,
  "suspended": false
}

```

### Delete Server

`DELETE /api/v1/servers/delete/:id`
*Requires Permissions: `servers`, `nodes*`

**Send:** None

**Get:**

```json
{
  "success": true
}

```

---

## Users

**Required Permission:** `users`

### List Users

`GET /api/v1/users`

**Send:** None

**Get:**

```json
{
  "success": true,
  "users": [ ... ]
}

```

### Get User Details

`GET /api/v1/user/:id`

**Send:** None

**Get:**

```json
{
  "success": true,
  "user": {
    "id": "...",
    "email": "...",
    "username": "..."
    // Password and 2FA secret are excluded
  },
  "servers": [ ... ]
}

```

### Get User Servers

`GET /api/v1/user/:id/servers`

**Send:** None

**Get:**

```json
{
  "success": true,
  "servers": [ ... ]
}

```

### Create User

`POST /api/v1/users/new`

**Send (JSON Body):**

```json
{
  "email": "user@example.com",
  "username": "user123",
  "password": "plainTextPassword",
  "admin": true // or false
}

```

**Get:**

```json
{
  "success": true,
  "user": {
    "id": "...",
    "email": "...",
    "username": "...",
    "admin": true
  }
}

```

### Edit User

`POST /api/v1/user/:id/edit`

**Send (JSON Body):**

```json
{
  "email": "new@example.com",
  "username": "newname",
  "password": "newpassword", // Will be hashed by server
  "admin": "true"
}

```

**Get:**

```json
{
  "success": true,
  "updates": { ... }
}

```

### Delete User

`POST /api/v1/user/:id/delete`
*Note: This also deletes all servers owned by the user.*

**Send:** None

**Get:**

```json
{
  "success": true
}

```

---

## Settings

**Required Permission:** `settings`

### Get Settings

`GET /api/v1/settings`

**Send:** None

**Get:**

```json
{
  "success": true,
  "settings": {
    "name": "App Name",
    "registerEnabled": true
  }
}

```

### Update Settings

`POST /api/v1/settings`

**Send (JSON Body):**

```json
{
  "name": "New App Name",
  "registerEnabled": false
}

```

**Get:**

```json
{
  "success": true,
  "settings": {
    "name": "New App Name",
    "registerEnabled": false
  }
}

```
