const JSON_HEADERS = { 'Content-Type': 'application/json' };

async function parse(response) {
  let data = null;
  try {
    data = await response.json();
  } catch (error) {
    data = null;
  }
  if (!response.ok) {
    const message = (data && data.error) || `请求失败（HTTP ${response.status}）`;
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }
  return data;
}

export const api = {
  async get(path) {
    return parse(await fetch(path, { cache: 'no-store' }));
  },
  async post(path, body) {
    return parse(await fetch(path, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify(body || {}),
    }));
  },
  async put(path, body) {
    return parse(await fetch(path, {
      method: 'PUT',
      headers: JSON_HEADERS,
      body: JSON.stringify(body || {}),
    }));
  },
  async del(path) {
    return parse(await fetch(path, { method: 'DELETE' }));
  },
  upload(file, dir, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `/api/upload?dir=${encodeURIComponent(dir)}&name=${encodeURIComponent(file.name)}`);
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable && onProgress) onProgress(event.loaded / event.total);
      };
      xhr.onload = () => {
        let data = null;
        try { data = JSON.parse(xhr.responseText); } catch (error) { data = null; }
        if (xhr.status >= 200 && xhr.status < 300) resolve(data);
        else reject(new Error((data && data.error) || `上传失败（HTTP ${xhr.status}）`));
      };
      xhr.onerror = () => reject(new Error('上传中断'));
      xhr.send(file);
    });
  },
};
