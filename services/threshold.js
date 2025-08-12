// services/threshold.js
function exceedsThreshold(value, threshold) {
  return threshold != null && value > threshold;
}

module.exports = { exceedsThreshold };
