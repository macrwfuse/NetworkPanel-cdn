<template>
  <el-dialog style="width: 90%;max-width: 500px;" v-model="visible" title="🚀 一键测速">
    <div style="text-align: center;">
      <!-- 测速仪表盘 -->
      <div ref="chartRef" style="width: 100%; height: 280px;"></div>

      <!-- 测速结果 -->
      <div v-if="phase === 'done'" style="margin-top: -20px;">
        <el-row :gutter="12">
          <el-col :span="6">
            <div class="result-item">
              <div class="result-value">{{ result.download || '-' }}</div>
              <div class="result-unit">Mbps ↓</div>
            </div>
          </el-col>
          <el-col :span="6">
            <div class="result-item">
              <div class="result-value">{{ result.upload || '-' }}</div>
              <div class="result-unit">Mbps ↑</div>
            </div>
          </el-col>
          <el-col :span="6">
            <div class="result-item">
              <div class="result-value">{{ result.ping || '-' }}</div>
              <div class="result-unit">ms 延迟</div>
            </div>
          </el-col>
          <el-col :span="6">
            <div class="result-item">
              <div class="result-value">{{ result.jitter || '-' }}</div>
              <div class="result-unit">ms 抖动</div>
            </div>
          </el-col>
        </el-row>
      </div>

      <!-- 当前状态 -->
      <div style="margin-top: 16px;">
        <el-text v-if="phase === 'idle'" type="info">点击开始测速</el-text>
        <el-text v-if="phase === 'ping'" type="warning">正在测试延迟... {{ currentLatency }}ms</el-text>
        <el-text v-if="phase === 'download'" type="primary">下载测速中... {{ currentSpeed }} Mbps</el-text>
        <el-text v-if="phase === 'upload'" type="success">上传测速中... {{ currentSpeed }} Mbps</el-text>
        <el-text v-if="phase === 'done'" type="success">✅ 测速完成</el-text>
      </div>

      <!-- 节点选择 -->
      <div style="margin-top: 16px;">
        <el-select v-model="selectedNode" style="width: 100%;" :disabled="testing">
          <el-option label="Cloudflare 全球节点" value="cloudflare" />
          <el-option label="字节CDN 节点" value="bytecdn" />
          <el-option label="和彩云 CDN" value="mcloud" />
          <el-option label="天翼云 CDN" value="ctyun" />
          <el-option label="Speedo云 CDN (30源)" value="speedo" />
          <el-option label="360云 CDN (10源)" value="cdn-360" />
          <el-option label="腾讯云 CDN" value="tencent" />
          <el-option label="自定义节点" value="custom" />
        </el-select>
      </div>

      <!-- 操作按钮 -->
      <div style="margin-top: 20px;">
        <el-button v-if="!testing" type="primary" size="large" @click="startTest" round>
          {{ phase === 'done' ? '再次测速' : '一键测速' }}
        </el-button>
        <el-button v-else type="danger" size="large" @click="stopTest" round>
          停止测速
        </el-button>
      </div>
    </div>
  </el-dialog>
</template>

<script setup lang="ts">
import { ref, watch, onMounted, nextTick } from 'vue'
import * as echarts from 'echarts'

const props = defineProps({
  modelValue: { type: Boolean, default: false },
})

const emit = defineEmits<{
  (e: 'update:modelValue', value: boolean): void
}>()

const visible = ref(props.modelValue)
watch(() => props.modelValue, (v) => { visible.value = v })
watch(visible, (v) => { emit('update:modelValue', v) })

const chartRef = ref<HTMLElement | null>(null)
const phase = ref('idle')
const testing = ref(false)
const currentSpeed = ref('0.00')
const currentLatency = ref(0)
const selectedNode = ref('cloudflare')

const result = ref({
  download: 0,
  upload: 0,
  ping: 0,
  jitter: 0,
})

let chart: echarts.ECharts | null = null
let worker: Worker | null = null

// 从数组中随机选取一个元素
function pickRandom<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]
}

const NODES: Record<string, any> = {
  cloudflare: {
    downloadUrl: 'https://speed.cloudflare.com/__down?bytes=25000000',
    uploadUrl: 'https://speed.cloudflare.com/__up',
    pingUrl: 'https://speed.cloudflare.com/__down?bytes=0',
    streams: 6,
    downloadTime: 10,
    uploadTime: 10,
  },
  bytecdn: {
    downloadUrl: 'https://lf9-apk.ugapk.cn/package/apk/aweme/5072_340301/aweme_douyin-huidu-gw-aweme-3430_v5072_340301_eea8_1747058635.apk',
    uploadUrl: 'https://speed.cloudflare.com/__up',
    pingUrl: 'https://lf3-cdn-tos.bytecdntp.com/',
    streams: 4,
    downloadTime: 10,
    uploadTime: 10,
  },
  'mcloud': {
    downloadUrls: ['https://img.mcloud.139.com/material_prod/material_media/20221128/1669626861087.png'],
    uploadUrl: 'https://speed.cloudflare.com/__up',
    pingUrl: 'http://webcdn.m.qq.com',
    streams: 6,
    downloadTime: 10,
    uploadTime: 10,
  },
  'ctyun': {
    downloadUrls: ['https://desk.ctyun.cn:8999/desktop-prod/software/windows_tob_client/15/64/202030001/CtyunClouddeskUniversal_2.3.0_202030001_x86_20240327104015_Setup.exe'],
    uploadUrl: 'https://speed.cloudflare.com/__up',
    pingUrl: 'http://webcdn.m.qq.com',
    streams: 6,
    downloadTime: 10,
    uploadTime: 10,
  },
  'speedo': {
    downloadUrls: [
      'https://lf9-apk.ugapk.cn/package/apk/aweme/5072_340301/aweme_douyin-huidu-gw-aweme-3430_v5072_340301_eea8_1747058635.apk',
      'https://cdn.aixifan.com/downloads/AcfunLive-Setup-1.9.0.200-ReleaseX64_6d5c40.exe',
      'https://devtools.qiniu.com/linux/amd64/qrsctl',
      'https://devtools.qiniu.com/qdoractl-darwin-amd64-0.4.6',
      'https://gw.alipayobjects.com/os/volans-demo/93211a67-0eed-40ff-8a48-f6c137a88781/MiniProgramStudio-3.1.3.exe',
      'https://8c8947-1956185621.antpcdn.com:19001/b/pkg-ant.baidu.com/issue/netdisk/LinuxGuanjia/4.17.7/baidunetdisk_4.17.7_amd64.deb',
      'https://downapp.sina.cn/m/06/sinaNews_8.27.0_1719288606_4386_3538_armeabi-v7a.apk',
      'https://i1.sinaimg.cn/edu/sinaopen/SinaOpencourse_V2.02.apk',
      'https://upgrade.k.sohu.com/upgrade/SohuNews_V7.3.6_0421110326_online_1003.apk',
      'https://statics.itc.cn/lt-app/sohumobile_official_gray_optimizeRelease_4_1.0.3_01161850.apk',
      'https://pkg.sinaimg.cn/weibo_13.11.1_vcode_6489_wm_3333_1001_so_32_64_weibo_5395_205935.apk',
      'https://open-image.ws.126.net/android_phone_release-sp_open-v9.9.9-v0a5b3c1dc0df472bb2fb057d0a5426c3.apk',
      'https://lf3-cdn-tos.bytegoofy.com/obj/douyin-pc-client/7044145585217083655/releases/8293088/1.0.8/win32-ia32/douyin-v1.0.8-win32-ia32-douyin.exe',
      'https://lf6-cdn-tos.bytegoofy.com/obj/douyin-pc-client/7044145585217083655/releases/8293088/1.0.8/win32-ia32/douyin-v1.0.8-win32-ia32-douyin.exe',
      'https://wwwstatic.vivo.com.cn/vivoportal/files/download/app/20231026/350bda07c8a0719919bcadbf5aea3538.apk',
      'https://cd.pddpic.com/android_dev/2023-11-08/a35eaee8e1f9f018cc40ace12931f7a2.apk',
      'https://1270e8-3086970414.antpcdn.com:19001/b/pkg-ant.baidu.com/issue/netdisk/yunguanjia/BaiduNetdisk_7.55.1.101.exe',
      'https://rls.tapimg.com/pub2/202310/64a7c775fa5503fc30f46c6fea6f9faf.apk',
      'https://uu.gdl.netease.com/4112/UU-4.68.1.exe',
      'https://cd.pddpic.com/android_dev/2024-06-26/06027b4121edcd1f106d992128a7124b.apk',
      'https://cd.pddpic.com/volantis-open/volantis-common/app/com.xunmeng.workBench/Release_1834716.exe',
      'https://cdn-ws.up366.cn/cn/files/setup/C72C242ED8400001EE2178A912E01146/2022/06/21/4dca83b3e1c461e070f75d2b485e75e7/up366-5.6.6.0.exe',
      'https://open-image.ws.126.net/android_phone_release-sp_open-v9.10.1-vb7b79d6b531448baaca3a81e7fbdc13f.apk',
      'https://lf3-package.vlabstatic.com/obj/faceu-packages/Jianying_split_4_8_0_10791_jianyingpro_0.exe',
      'https://lf6-package.vlabstatic.com/obj/faceu-packages/Jianying_split_4_8_0_10791_jianyingpro_0.exe',
      'https://lf9-package.vlabstatic.com/obj/faceu-packages/Jianying_split_4_8_0_10791_jianyingpro_0.exe',
      'https://file.ljcdn.com/saas-pkg/asaas-new/new_asaas_4.0.56_win_prod.zip',
      'https://video19.ifeng.com/video09/2022/07/06/p6950362006465552946-102-162611.mp4',
      'https://apk.360buyimg.com/build-cms/V5.2.0-4258-800000136-bazaar-64bit.apk',
      'https://download.jr.jd.com/downapp/jrapp_jr9631.apk'
    ],
    uploadUrls: [
      'https://test.ustc.edu.cn/backend/empty.php?cors=1',
      'https://iptv.tsinghua.edu.cn/st/empty.php?cors=1',
      'https://ftp.sjtu.edu.cn/speedtest/backend/empty.php?cors=1',
      'https://test.nju.edu.cn/backend/empty.php?cors=1',
      'https://219.140.61.101/backend/empty.php?cors=1',
      'https://119.36.86.250:81/backend/empty.php?cors=1',
      'http://211.67.53.2/backend/empty.php?cors=1'
    ],
    pingUrl: 'http://webcdn.m.qq.com',
    streams: 6,
    downloadTime: 10,
    uploadTime: 10,
  },
  'cdn-360': {
    downloadUrls: [
      'https://cdn.qq.ime.sogou.com/QQPinyin_Setup_6.6.6304.400.exe',
      'http://softdlc.360tpcdn.com/auto/20201130/2000000064_f07aefc3d918ebdafa9418f3f5ef5f9c.exe',
      'https://dldir1.qq.com/qqtv/TencentVideo11.99.8523.0.exe',
      'http://softdlc.360tpcdn.com/auto/20201127/23_21ed487ededbbb428b2a7dcecc969c7c.exe',
      'https://download.cntv.cn/cbox/v6/ysyy_v6.0.3.3_1001_setup_x64.exe?spm=0.PF8WgFTOZypm.ETms2K8Lsimc.6&file=ysyy_v6.0.3.3_1001_setup_x64.exe',
      'http://softdlc.360tpcdn.com/auto/20201127/100101123_879baf4f2d9d14f191be2443e16504af.exe',
      'https://dl.2345.com/pic/2345pic_x64_v11.3.0.10165.exe',
      'http://bigsoftdlc.360tpcdn.com/auto/20200826/104511_999095167454c21f770b31e8f080ebb7.exe',
      'http://bigsoftdlc.360tpcdn.com/auto/20210401/103779382_99dafefbd4193095a95fa713348fe6e7.exe',
      'http://bigsoftdlc.360tpcdn.com/auto/20201125/105005364_74cbde2c220e12dbd49b2c86e0ab2c6f.exe'
    ],
    uploadUrl: 'https://speed.cloudflare.com/__up',
    pingUrl: 'http://webcdn.m.qq.com',
    streams: 6,
    downloadTime: 10,
    uploadTime: 10,
  },
  'tencent': {
    downloadUrls: ['http://webcdn.m.qq.com/speed/SpeedTestData.dat'],
    uploadUrl: 'http://netsp.master.qq.com/cgi-bin/netspeed',
    pingUrl: 'http://webcdn.m.qq.com',
    streams: 6,
    downloadTime: 10,
    uploadTime: 10,
  },
}

function initChart() {
  if (!chartRef.value) return
  chart = echarts.init(chartRef.value)
  chart.setOption({
    series: [{
      type: 'gauge',
      startAngle: 220,
      endAngle: -40,
      min: 0,
      max: 1000,
      progress: { show: true, width: 18, itemStyle: { color: '#409eff' } },
      axisLine: { lineStyle: { width: 18, color: [[1, '#e4e7ed']] } },
      axisTick: { show: false },
      splitLine: { show: false },
      axisLabel: { show: false },
      pointer: { show: false },
      detail: {
        valueAnimation: true,
        fontSize: 36,
        fontWeight: 'bold',
        formatter: '{value}',
        offsetCenter: [0, '10%'],
        color: '#303133',
      },
      title: {
        fontSize: 14,
        offsetCenter: [0, '45%'],
        color: '#909399',
      },
      data: [{ value: 0, name: 'Mbps' }],
    }],
  })
}

function updateGauge(value: number, label: string) {
  if (!chart) return
  // 自动调整刻度
  var max = 100
  if (value > 100) max = 500
  if (value > 500) max = 1000
  if (value > 1000) max = 5000
  if (value > 5000) max = 10000

  chart.setOption({
    series: [{
      max: max,
      data: [{ value: parseFloat(value.toFixed(1)), name: label }],
      axisLine: {
        lineStyle: {
          color: [
            [0.3, '#67c23a'],
            [0.7, '#e6a23c'],
            [1, '#f56c6c'],
            [1, '#e4e7ed'],
          ]
        }
      },
    }]
  })
}

function startTest() {
  if (testing.value) return
  testing.value = true
  phase.value = 'idle'
  result.value = { download: 0, upload: 0, ping: 0, jitter: 0 }
  currentSpeed.value = '0.00'
  currentLatency.value = 0
  updateGauge(0, 'Mbps')

  const rawConfig = NODES[selectedNode.value] || NODES.cloudflare
  // 支持 downloadUrls 数组：随机选取一个下载 URL
  const nodeConfig = { ...rawConfig }
  if (nodeConfig.downloadUrls && nodeConfig.downloadUrls.length > 0) {
    nodeConfig.downloadUrl = pickRandom(nodeConfig.downloadUrls)
  }
  if (nodeConfig.uploadUrls && nodeConfig.uploadUrls.length > 0) {
    nodeConfig.uploadUrl = pickRandom(nodeConfig.uploadUrls)
  }

  worker = new Worker('/speedtest-worker.js')
  worker.onmessage = function (e) {
    const msg = e.data
    if (msg.type === 'status') {
      const d = msg.data
      phase.value = d.phase

      if (d.phase === 'download' || d.phase === 'upload') {
        currentSpeed.value = d.speed || '0.00'
        updateGauge(parseFloat(d.speed) || 0, d.phase === 'download' ? '下载 Mbps' : '上传 Mbps')
      }
      if (d.phase === 'ping') {
        currentLatency.value = d.latency || 0
      }
      if (d.phase === 'done') {
        testing.value = false
      }
    } else if (msg.type === 'result') {
      result.value = msg.data
      updateGauge(msg.data.download || 0, '下载 Mbps')
    } else if (msg.type === 'error') {
      console.error('SpeedTest error:', msg.data.message)
      testing.value = false
      phase.value = 'idle'
    }
  }

  worker.postMessage({
    cmd: 'start',
    order: 'P_D_U',
    settings: nodeConfig,
  })
}

function stopTest() {
  if (worker) {
    worker.postMessage({ cmd: 'stop' })
    worker.terminate()
    worker = null
  }
  testing.value = false
  phase.value = 'idle'
}

watch(visible, (v) => {
  if (v) {
    nextTick(() => {
      initChart()
    })
  }
})

onMounted(() => {
  if (visible.value) initChart()
})
</script>

<style scoped>
.result-item {
  text-align: center;
  padding: 8px 4px;
}
.result-value {
  font-size: 24px;
  font-weight: 700;
  color: #303133;
}
.result-unit {
  font-size: 12px;
  color: #909399;
  margin-top: 4px;
}
@media (prefers-color-scheme: dark) {
  .result-value {
    color: #e5eaf3;
  }
}
</style>
