import {createPublicClient, http, parseAbi} from 'viem'
import {gnosis} from 'viem/chains'
import {readFileSync} from 'node:fs'
const pub=createPublicClient({chain:gnosis,transport:http('https://rpc.gnosischain.com',{batch:true})})
const OV='0xff896a936f4c6b39c8c123a3d5d2b252c054af6dec567afe3220a1490d53eeb2'
const cands=[...new Set(readFileSync('/tmp/cands.txt','utf8').trim().split('\n').map(s=>s.trim()).filter(Boolean))]
const abi=parseAbi([
  'function minimumStakeAmount() view returns (uint256)',
  'function MIN_STAKE() view returns (uint256)',
  'function usableStakeOfOverlay(bytes32) view returns (uint256)',
])
for (const a of cands) {
  const out=[]
  for (const fn of ['minimumStakeAmount','MIN_STAKE']) {
    try { const v=await pub.readContract({address:a,abi,functionName:fn}); out.push(`${fn}=${(Number(v)/1e16).toFixed(2)} xBZZ`) } catch {}
  }
  try { const v=await pub.readContract({address:a,abi,functionName:'usableStakeOfOverlay',args:[OV]}); out.push(`usableStakeOfOverlay=${(Number(v)/1e16).toFixed(4)}`) } catch {}
  if (out.length) console.log(' ',a,'->',out.join('  '))
}
