import os
from datetime import datetime, timedelta, timezone
import jwt
import bcrypt
from dotenv import load_dotenv

load_dotenv()

SECRET_KEY = os.getenv("JWT_SECRET", "change-this-secret-key")
ALGORITHM = "HS256"
ACCESS_TOKEN_MINUTES = 60 * 24

def hash_password(password: str) -> str:
    pwd_bytes = password.encode("utf-8")[:72]
    return bcrypt.hashpw(pwd_bytes, bcrypt.gensalt()).decode("utf-8")

def verify_password(password: str, hashed: str) -> bool:
    try:
        pwd_bytes = password.encode("utf-8")[:72]
        hashed_bytes = hashed.encode("utf-8")
        return bcrypt.checkpw(pwd_bytes, hashed_bytes)
    except Exception:
        return False

def create_access_token(user_id: str) -> str:
    expires = datetime.now(timezone.utc) + timedelta(minutes=ACCESS_TOKEN_MINUTES)
    return jwt.encode({"sub": user_id, "exp": expires}, SECRET_KEY, algorithm=ALGORITHM)

def decode_token(token: str) -> str:
    payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
    return payload["sub"]


# =========================================================================
# Authenticated Database Encryption for Sensitive API Keys
# Algorithm: PBKDF2 (100k rounds) + ChaCha20 + HMAC-SHA256 (Encrypt-then-MAC)
# Stored safely in MongoDB under users_collection
# =========================================================================
import struct
import secrets
import hashlib
import hmac
import base64

def _rot32(v: int, c: int) -> int:
    return ((v << c) & 0xFFFFFFFF) | (v >> (32 - c))

def _quarter_round(x, a, b, c, d):
    x[a] = (x[a] + x[b]) & 0xFFFFFFFF
    x[d] = _rot32(x[d] ^ x[a], 16)
    x[c] = (x[c] + x[d]) & 0xFFFFFFFF
    x[b] = _rot32(x[b] ^ x[c], 12)
    x[a] = (x[a] + x[b]) & 0xFFFFFFFF
    x[d] = _rot32(x[d] ^ x[a], 8)
    x[c] = (x[c] + x[d]) & 0xFFFFFFFF
    x[b] = _rot32(x[b] ^ x[c], 7)

def _chacha20_block(key_bytes: bytes, counter: int, nonce_bytes: bytes) -> bytes:
    constants = [0x61707865, 0x3320646e, 0x79622d32, 0x6b206574]
    key_words = list(struct.unpack('<8I', key_bytes))
    nonce_words = list(struct.unpack('<3I', nonce_bytes))
    state = constants + key_words + [counter] + nonce_words
    w = list(state)
    for _ in range(10):
        _quarter_round(w, 0, 4, 8, 12)
        _quarter_round(w, 1, 5, 9, 13)
        _quarter_round(w, 2, 6, 10, 14)
        _quarter_round(w, 3, 7, 11, 15)
        _quarter_round(w, 0, 5, 10, 15)
        _quarter_round(w, 1, 6, 11, 12)
        _quarter_round(w, 2, 7, 8, 13)
        _quarter_round(w, 3, 4, 9, 14)
    out_words = [(w[i] + state[i]) & 0xFFFFFFFF for i in range(16)]
    return struct.pack('<16I', *out_words)

def _chacha20_crypt(key_bytes: bytes, nonce_bytes: bytes, data_bytes: bytes) -> bytes:
    out = bytearray(len(data_bytes))
    idx = 0
    counter = 1
    while idx < len(data_bytes):
        block = _chacha20_block(key_bytes, counter, nonce_bytes)
        chunk = min(64, len(data_bytes) - idx)
        for i in range(chunk):
            out[idx + i] = data_bytes[idx + i] ^ block[i]
        idx += chunk
        counter += 1
    return bytes(out)

def encrypt_api_key(plaintext: str, user_id: str) -> str:
    """
    Encrypts an API key before persisting to MongoDB.
    Generates fresh 16-byte salt and 12-byte nonce per encryption.
    Uses PBKDF2 (100,000 iterations) tied to server secret + user_id.
    Appends HMAC-SHA256 authentication tag for cryptographic integrity.
    """
    if not plaintext or not plaintext.strip():
        return ""
    clean = plaintext.strip()
    salt = secrets.token_bytes(16)
    nonce = secrets.token_bytes(12)
    master = f"{SECRET_KEY}:{user_id}:clove_mongo_vault".encode("utf-8")
    derived = hashlib.pbkdf2_hmac("sha256", master, salt, 100000, 64)
    cipher_key = derived[:32]
    mac_key = derived[32:]
    
    ciphertext = _chacha20_crypt(cipher_key, nonce, clean.encode("utf-8"))
    tag = hmac.new(mac_key, salt + nonce + ciphertext, hashlib.sha256).digest()
    
    packet = salt + nonce + tag + ciphertext
    return "enc:mongo:v1:" + base64.b64encode(packet).decode("ascii")

def decrypt_api_key(ciphertext_str: str, user_id: str) -> str:
    """
    Decrypts an API key retrieved from MongoDB in-memory.
    Verifies HMAC-SHA256 tag in constant time before decrypting.
    """
    if not ciphertext_str or not ciphertext_str.startswith("enc:mongo:v1:"):
        return ""
    try:
        raw_b64 = ciphertext_str[13:]
        packet = base64.b64decode(raw_b64)
        if len(packet) < 60:  # 16 salt + 12 nonce + 32 tag + min 1 ciphertext
            return ""
        salt = packet[:16]
        nonce = packet[16:28]
        tag = packet[28:60]
        ciphertext = packet[60:]
        
        master = f"{SECRET_KEY}:{user_id}:clove_mongo_vault".encode("utf-8")
        derived = hashlib.pbkdf2_hmac("sha256", master, salt, 100000, 64)
        cipher_key = derived[:32]
        mac_key = derived[32:]
        
        expected_tag = hmac.new(mac_key, salt + nonce + ciphertext, hashlib.sha256).digest()
        if not hmac.compare_digest(tag, expected_tag):
            return ""  # Tampered or invalid key
            
        decrypted = _chacha20_crypt(cipher_key, nonce, ciphertext)
        return decrypted.decode("utf-8")
    except Exception:
        return ""

