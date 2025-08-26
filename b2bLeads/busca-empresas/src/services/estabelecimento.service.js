// services/help.js
import qs from 'qs';
import { get } from '@/api';

const controller = 'estabelecimento';

export async function FindAllEstabelecimento(queryParams) {
  const http = await get();
  const queryString = queryParams
    ? qs.stringify(queryParams, {
        addQueryPrefix: true, // já põe "?"
        encode: false,
        allowDots: true,
        arrayFormat: 'repeat',
      })
    : '';
  const { data } = await http.get(`${controller}${queryString}`);
  return data;
}

export async function FindOneEstabelecimento(id) {
  const http = await get();
  const { data } = await http.get(`${controller}/${id}`);
  return data;
}

export async function PostEstabelecimento(dado) {
  const http = await get();
  const { data } = await http.post(`${controller}`, dado);
  return data;
}

export async function PutEstabelecimento(dado, id) {
  const http = await get();
  const { data } = await http.put(`${controller}/${id}`, dado);
  return data;
}

export async function RemoveEstabelecimento(id) {
  const http = await get();
  const { data } = await http.delete(`${controller}/${id}`);
  return data;
}
