#!/usr/bin/env python3
"""Poll Belkins BirdNET's recent-detections endpoint once a minute and publish
each new species to MQTT. Edit BROKER, TOPIC_PREFIX, and PI_URL below."""
import json
import time
import urllib.request
import paho.mqtt.client as mqtt  # sudo pip3 install paho-mqtt

BROKER = "homeassistant.local"
PORT = 1883
USER = ""
PASSWORD = ""
TOPIC_PREFIX = "birdnet"
PI_URL = "http://birdnet.local/avian/api/birdnet-api.php?action=recent&hours=1"

seen_keys: set[str] = set()


def slugify(s: str) -> str:
    return "".join(c.lower() if c.isalnum() else "-" for c in s).strip("-")


def loop(client: mqtt.Client) -> None:
    while True:
        try:
            with urllib.request.urlopen(PI_URL, timeout=10) as r:
                payload = json.loads(r.read())
            for s in payload.get("species", []):
                key = f"{s['sci']}|{s.get('last_seen', '')}"
                if key in seen_keys:
                    continue
                seen_keys.add(key)
                topic = f"{TOPIC_PREFIX}/{slugify(s['sci'])}"
                client.publish(topic, json.dumps(s), qos=0, retain=False)
                print(f"published {topic}: {s.get('com')}")
        except Exception as e:
            print(f"poll error: {e}")
        time.sleep(60)


def main() -> None:
    # paho-mqtt 2.x requires CallbackAPIVersion; the constructor below
    # also works on 1.x (the kwarg is just ignored). Pin to VERSION2 so
    # we get the modern callback signatures going forward.
    try:
        client = mqtt.Client(callback_api_version=mqtt.CallbackAPIVersion.VERSION2)
    except AttributeError:  # paho-mqtt 1.x
        client = mqtt.Client()
    if USER:
        client.username_pw_set(USER, PASSWORD)
    client.connect(BROKER, PORT, keepalive=60)
    client.loop_start()
    loop(client)


if __name__ == "__main__":
    main()
