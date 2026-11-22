#!/usr/bin/env bash
set -euo pipefail

host="${MONGO_PRIMARY_HOST:-mongodb-primary:27017}"
username="${MONGO_INITDB_ROOT_USERNAME:-admin}"
password="${MONGO_INITDB_ROOT_PASSWORD:-password}"

echo "Waiting for MongoDB at ${host}..."
for attempt in $(seq 1 60); do
  if mongosh --quiet --host "$host" --eval 'db.adminCommand({ ping: 1 }).ok' >/dev/null 2>&1; then
    break
  fi
  if [ "$attempt" -eq 60 ]; then
    echo "MongoDB did not become reachable within 60 seconds" >&2
    exit 1
  fi
  sleep 1
done

configured="$(mongosh --quiet --host "$host" --eval 'print(db.hello().setName ? "configured" : "unconfigured")' | tail -n 1)"
if [ "$configured" = "unconfigured" ]; then
  echo "Initializing MongoDB replica set..."
  mongosh --quiet --host "$host" --eval '
    rs.initiate({
      _id: "rs0",
      members: [
        { _id: 0, host: "mongodb-primary:27017", priority: 2 },
        { _id: 1, host: "mongodb-secondary:27017", priority: 1 },
        { _id: 2, host: "mongodb-arbiter:27017", arbiterOnly: true }
      ]
    })
  '
else
  echo "Replica set already configured; preserving it"
fi

echo "Waiting for writable primary..."
for attempt in $(seq 1 60); do
  if mongosh --quiet --host "$host" --eval 'quit(db.hello().isWritablePrimary ? 0 : 1)' >/dev/null 2>&1; then
    break
  fi
  if [ "$attempt" -eq 60 ]; then
    echo "MongoDB did not elect a writable primary within 60 seconds" >&2
    exit 1
  fi
  sleep 1
done

MONGO_INITDB_ROOT_USERNAME="$username" MONGO_INITDB_ROOT_PASSWORD="$password" mongosh --quiet --host "$host" --eval '
  const admin = db.getSiblingDB("admin");
  const username = process.env.MONGO_INITDB_ROOT_USERNAME;
  const password = process.env.MONGO_INITDB_ROOT_PASSWORD;
  if (admin.getUser(username)) {
    print("Admin user already exists; preserving it");
  } else {
    admin.createUser({ user: username, pwd: password, roles: [{ role: "root", db: "admin" }] });
    print("Admin user created");
  }
'

echo "MongoDB initialization complete"
