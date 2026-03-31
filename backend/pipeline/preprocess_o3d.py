import os, sys, struct, json
import numpy as np
import open3d as o3d
from scipy.signal import find_peaks
import matplotlib.pyplot as plt

def load_pointcloud_bin(bin_path):
    print(f"Loading {bin_path}...")
    with open(bin_path, 'rb') as f:
        buf = f.read()
    
    # Header: N uint32
    N = struct.unpack('<I', buf[:4])[0]
    
    # Points: N*3 float32
    pos = np.frombuffer(buf, dtype=np.float32, count=N*3, offset=4).reshape(N, 3)
    
    # Colors: N*3 uint8
    col = np.frombuffer(buf, dtype=np.uint8, count=N*3, offset=4 + N*12).reshape(N, 3)
    
    pcd = o3d.geometry.PointCloud()
    pcd.points = o3d.utility.Vector3dVector(pos)
    pcd.colors = o3d.utility.Vector3dVector(col / 255.0)
    
    return pcd

def detect_floors(pcd, output_dir, debug=True):
    # In three.js Y is UP, so our height axis is Y (index 1)
    # The bounding box max-min is from the pcd coordinates
    points = np.asarray(pcd.points)
    y_coords = points[:, 1]
    
    # Let's create a histogram of the height (Y axis)
    y_min, y_max = y_coords.min(), y_coords.max()
    print(f"Height range (Y axis): {y_min:.2f} to {y_max:.2f}")
    
    # We use a bin size of 5cm
    bin_size = 0.05 
    bins = np.arange(y_min, y_max + bin_size, bin_size)
    hist, bin_edges = np.histogram(y_coords, bins=bins)
    
    # Find peaks. 
    # Height of floors usually corresponds to a large number of points at floor level (and ceiling)
    # distance=2.5m roughly (50 bins of 5cm = 2.5m)
    min_dist_bins = int(2.0 / bin_size) 
    
    peaks, properties = find_peaks(hist, distance=min_dist_bins, prominence=max(hist)*0.1)
    
    floor_y_vals = []
    for p in peaks:
        floor_y = float(bin_edges[p])
        floor_y_vals.append(floor_y)
        print(f"Detected floor level at Y = {floor_y:.2f}m")
    
    if debug:
        plt.figure(figsize=(10, 4))
        plt.plot(bin_edges[:-1], hist)
        plt.plot(bin_edges[peaks], hist[peaks], "x", color='red')
        plt.title('Z-Histogram (Height distribution)')
        plt.xlabel('Height (m)')
        plt.ylabel('Point count')
        plt.grid(True)
        debug_path = os.path.join(output_dir, "histogram.png")
        plt.savefig(debug_path)
        print(f"Saved debug histogram to {debug_path}")
        
    return floor_y_vals
        
def main():
    BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    PROCESSED_DIR = os.path.join(BASE_DIR, 'processed')
    bin_path = os.path.join(PROCESSED_DIR, 'pointcloud.bin')
    info_path = os.path.join(PROCESSED_DIR, 'info.json')
    
    if not os.path.exists(bin_path):
        print("Error: pointcloud.bin not found. Run preprocess.py first.")
        sys.exit(1)
        
    # 1. Load PointCloud
    pcd = load_pointcloud_bin(bin_path)
    print(f"Point cloud loaded with {len(pcd.points)} points.")
    
    # 2. Voxel downsample using Open3D (creates uniform distribution, 5cm)
    print("Voxel downsampling (5cm)...")
    pcd_down = pcd.voxel_down_sample(voxel_size=0.05)
    print(f"Downsampled from {len(pcd.points)} to {len(pcd_down.points)} points.")
    
    # 3. Statistical outlier removal
    print("Removing statistical outliers...")
    pcd_clean, ind = pcd_down.remove_statistical_outlier(nb_neighbors=20, std_ratio=2.0)
    print(f"Cleaned point cloud has {len(pcd_clean.points)} points.")
    
    # 4. Detect floors
    print("Detecting floors from density peaks...")
    floor_levels = detect_floors(pcd_clean, PROCESSED_DIR, debug=True)
    
    # Save the floor bands to info.json
    with open(info_path, 'r') as f:
        info = json.load(f)
        
    # Each floor band is typically from the peak (floor) to ~2.5m height
    # We will slice them later. Let's just store the levels.
    info['floor_levels'] = floor_levels
    
    with open(info_path, 'w') as f:
        json.dump(info, f, indent=2)
        
    print(f"Updated {info_path} with floor bands.")

if __name__ == '__main__':
    main()
